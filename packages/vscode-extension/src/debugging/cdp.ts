export type CDPRemoteObject =
  | {
      type: "undefined";
    }
  | {
      type: "string" | "number" | "boolean" | "symbol" | "bigint";
      description?: string;
      value?: any;
      unserializableValue?: string;
    }
  | {
      type: "function";
      description?: string;
    }
  | {
      type: "object";
      subtype?: "array";
      objectId: string;
      className: string;
      description?: string;
    };

export type CDPPropertyDescriptor = {
  name: string;
  value?: CDPRemoteObject;
};

export type CDPDebuggerScope = {
  type: "global" | "local" | "with" | "closure" | "catch" | "block" | "script" | "eval" | "module";
  name?: string;
  object: CDPRemoteObject & { type: "object" };
};

export type CDPProfile = {
  nodes: CDPProfileNode[];
  startTime: number;
  endTime: number;
  samples?: number[];
  timeDeltas?: number[];
};

export type CDPProfileNode = {
  id: number;
  callFrame: CDPCallFrame;
  hitCount?: number;
  children?: number[];
  deoptReason?: string;
  positionTicks?: CDPPositionTick[];
};

export type CDPPositionTick = {
  line: number; // 1-based according to the spec, WTF!
  ticks: number;
};

export type CDPCallFrame = {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number; // 0-based
  columnNumber: number; // 0-based
};

export function inferDAPVariableValueForCDPRemoteObject(cdpValue: CDPRemoteObject): string {
  switch (cdpValue.type) {
    case "undefined":
      return "undefined";
    case "string":
    case "number":
    case "boolean":
    case "symbol":
    case "bigint":
      if (cdpValue.unserializableValue) {
        return cdpValue.unserializableValue;
      }
      return cdpValue.value.toString();
    case "function":
      return cdpValue.description || "method";
    case "object":
      return cdpValue.description || "object";
  }
}

export function inferDAPScopePresentationHintFromCDPType(cdpScopeType: string) {
  // Allowed Values: global, local, with, closure, catch, block, script, eval, module, wasm-expression-stack
  // DAP scope presentation hints can be: 'arguments' | 'locals' | 'registers' | string;
  switch (cdpScopeType) {
    case "local":
      return "locals";
    case "global":
      return "globals";
    default:
      return cdpScopeType;
  }
}
