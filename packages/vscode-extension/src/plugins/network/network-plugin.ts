import http, { Server } from "http";
import { spawn } from "child_process";
import path from "path";
import {
  commands,
  Disposable,
  Position,
  Range,
  Selection,
  TextEditorRevealType,
  ViewColumn,
  window,
  workspace,
} from "vscode";
import { WebSocketServer, WebSocket } from "ws";
import { Devtools } from "../../project/devtools";
import { ToolKey, ToolPlugin } from "../../project/tools";
import { extensionContext } from "../../utilities/extensionContext";

import { Logger } from "../../Logger";
import { NetworkDevtoolsWebviewProvider } from "./NetworkDevtoolsWebviewProvider";
import { DebugSession } from "../../debugging/DebugSession";

export const NETWORK_PLUGIN_ID = "network";
const EXCLUDED_MODULES = [
  "node_modules",
  "webpack",
  "rn-renderer",
  "metro",
  "babel",
  "core-js",
  "regenerator-runtime",
  "react-native",
  "react",
  "react-dom",
  "radon-ide",
  "scheduler",
];

function startViteServer(onReady: () => void) {
  const process = spawn("npm", ["run", "watch:network-webview"], {
    cwd: path.join(__dirname, ".."),
    shell: true,
  });

  process.stdout.on("data", (data) => {
    const output = data.toString();

    if (output.includes("ready in") || output.includes("Local:")) {
      onReady();
    }
  });

  process.stderr.on("data", (data) => {
    Logger.error("ERROR:", data.toString());
  });

  process.on("close", (code) => {
    Logger.debug(`Process exited with code ${code}`);
  });
}

let initialzed = false;
function initialize() {
  if (initialzed) {
    return;
  }
  Logger.debug("Initilizing Network tool");

  startViteServer(() => {
    initialzed = true;
    extensionContext.subscriptions.push(
      window.registerWebviewViewProvider(
        `RNIDE.Tool.Network.view`,
        new NetworkDevtoolsWebviewProvider(extensionContext),
        { webviewOptions: { retainContextWhenHidden: true } }
      )
    );
  });
}

class NetworkCDPWebsocketBackend implements Disposable {
  private server: Server;
  private sessions: Set<WebSocket> = new Set();

  constructor(
    private readonly devtools: Devtools,
    private readonly debugSession: DebugSession | undefined
  ) {
    this.server = http.createServer(() => {});
    const wss = new WebSocketServer({ server: this.server });

    wss.on("connection", (ws) => {
      this.sessions.add(ws);

      ws.on("message", (message) => {
        try {
          const payload = JSON.parse(message.toString());
          if (
            ["Network.getResponseBody", "Network.enable", "Network.disable"].includes(
              payload.method
            )
          ) {
            // forward message to devtools
            this.devtools.send("RNIDE_networkInspectorCDPRequest", payload);
          } else if (payload.method === "Network.Initiator") {
            (async () => {
              for (const e of payload.params.stackTrace) {
                if (!this.debugSession) {
                  Logger.error("Network.Initiator: DebugSession is not available");
                  return;
                }

                const result = await this.debugSession.getOriginalSource(
                  e.url,
                  e.lineNumber,
                  e.columnNumber
                );

                // Check if the sourceURL is pointing to file written by user
                if (
                  result &&
                  !EXCLUDED_MODULES.some((excluded) => result.sourceURL.includes(excluded))
                ) {
                  try {
                    const document = await workspace.openTextDocument(result.sourceURL);
                    const editor = await window.showTextDocument(document, {
                      viewColumn: ViewColumn.Active,
                      preserveFocus: false,
                    });

                    const position = new Position(
                      result.lineNumber1Based - 1,
                      result.columnNumber0Based
                    );

                    editor.revealRange(
                      new Range(position, position),
                      TextEditorRevealType.InCenter
                    );
                    editor.selection = new Selection(position, position);

                    const highlightRange = new Range(
                      position.line,
                      0,
                      position.line,
                      document.lineAt(position.line).text.length
                    );
                    const decorationType = window.createTextEditorDecorationType({
                      backgroundColor: "rgba(255, 255, 0, 0.3)",
                    });

                    editor.setDecorations(decorationType, [highlightRange]);

                    const disposable = window.onDidChangeTextEditorSelection((event) => {
                      if (event.textEditor === editor) {
                        const isCursorOnHighlightedLine = event.selections.some(
                          (selection) => selection.active.line === position.line
                        );
                        if (!isCursorOnHighlightedLine) {
                          editor.setDecorations(decorationType, []);
                          disposable.dispose();
                        }
                      }
                    });

                    break;
                  } catch (err) {}
                }
              }
            })();
          } else if (payload.id) {
            // send empty response otherwise
            const response = { id: payload.id, result: {} };
            ws.send(JSON.stringify(response));
          }
        } catch (err) {
          console.error("Network CDP invalid message format:", err);
        }
      });

      ws.on("close", () => {
        this.sessions.delete(ws);
      });
    });
  }

  public get port() {
    const address = this.server.address();
    Logger.debug("Server address:", address);

    if (address && typeof address === "object") {
      return address.port;
    }
    throw new Error("Server address is not available");
  }

  public async start() {
    // if server is already started, we return immediately
    if (this.server.listening) {
      return;
    }
    return new Promise<void>((resolve) => {
      this.server.listen(0, () => {
        resolve();
      });
    });
  }

  public broadcast(cdpMessage: string) {
    this.sessions.forEach((ws) => {
      ws.send(cdpMessage);
    });
  }

  public dispose() {
    this.server.close();
  }
}

export class NetworkPlugin implements ToolPlugin {
  public readonly id: ToolKey = NETWORK_PLUGIN_ID;
  public readonly label = "Network";

  public available = false;
  public readonly persist = true;

  private readonly websocketBackend;

  constructor(
    private readonly devtools: Devtools,
    private readonly debugSession: DebugSession | undefined
  ) {
    this.websocketBackend = new NetworkCDPWebsocketBackend(devtools, this.debugSession);
    initialize();
  }

  public get websocketPort() {
    return this.websocketBackend.port;
  }

  activate(): void {
    this.websocketBackend.start().then(() => {
      commands.executeCommand("setContext", `RNIDE.Tool.Network.available`, true);
      this.devtools.addListener(this.devtoolsListener);
      this.devtools.send("RNIDE_enableNetworkInspect", { enable: true });
    });
  }

  devtoolsListener = (event: string, payload: any) => {
    if (event === "RNIDE_networkInspectorCDPMessage") {
      this.websocketBackend.broadcast(payload);
    } else if (event === "RNIDE_appReady") {
      this.devtools.send("RNIDE_enableNetworkInspect", { enable: true });
    }
  };

  deactivate(): void {
    this.devtools.removeListener(this.devtoolsListener);
    this.devtools.send("RNIDE_enableNetworkInspect", { enable: false });
    commands.executeCommand("setContext", `RNIDE.Tool.Network.available`, false);
  }

  openTool(): void {
    commands.executeCommand(`RNIDE.Tool.Network.view.focus`);
  }

  dispose() {
    this.devtools.removeListener(this.devtoolsListener);
  }
}
