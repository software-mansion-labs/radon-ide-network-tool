import {
  PropsWithChildren,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { vscode } from "../utilities/vscode";
import { Device, PLATFORM } from "../utilities/device";
import { useGlobalStateContext } from "./GlobalStateProvider";
export interface AndroidSystemImage {
  path: string;
  version: string;
  description: string;
  location?: string;
}

export type InstalledAndroidSystemImage = {
  apiLevel: number;
} & AndroidSystemImage;

export interface IosRuntime {
  bundlePath: string;
  buildversion: string;
  platform: "iOS" | "tvOS" | "watchOS";
  runtimeRoot: string;
  identifier: string;
  version: string;
  isInternal: boolean;
  isAvailable: boolean;
  name: string;
  supportedDeviceTypes: Array<{ name: string; identifier: string }>;
}

interface SystemImagesContextProps {
  androidImages: AndroidSystemImage[];
  installedAndroidImages: InstalledAndroidSystemImage[];
  androidInstallationOutputStream: string;
  loading: boolean;
  isDeviceImageInstalled: (device?: Device) => boolean;
  processAndroidImageChanges: ({
    toInstall,
    toRemove,
  }: {
    toInstall?: AndroidSystemImage[];
    toRemove?: AndroidSystemImage[];
  }) => Promise<void>;
  processIosRuntimeChanges: ({
    toInstall,
    toRemove,
  }: {
    toInstall?: string[];
    toRemove?: IosRuntime[];
  }) => Promise<void>;
  removeDeviceWithImage: (device: Device) => Promise<void>;
}

const SystemImagesContext = createContext<SystemImagesContextProps>({
  androidImages: [],
  installedAndroidImages: [],
  androidInstallationOutputStream: "",
  loading: false,
  isDeviceImageInstalled: (device?: Device) => false,
  processAndroidImageChanges: () => new Promise<void>((resolve) => resolve()),
  processIosRuntimeChanges: () => new Promise<void>((resolve) => resolve()),
  removeDeviceWithImage: () => new Promise<void>((resolve) => resolve()),
});

export default function SystemImagesProvider({ children }: PropsWithChildren) {
  const [androidImages, setAndroidImages] = useState<AndroidSystemImage[]>([]);
  const [installedAndroidImages, setInstalledAndroidImages] = useState<
    InstalledAndroidSystemImage[]
  >([]);
  const [androidInstallationOutputStream, setAndroidInstallationOutputStream] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const listener = (event: any) => {
      const message = event.data;
      switch (message.command) {
        case "allAndroidImagesListed":
          setAndroidImages(message.availableImages);
          setInstalledAndroidImages(message.installedImages);
          break;
        case "streamAndroidInstallationProgress":
          setAndroidInstallationOutputStream(message.stream);
          break;
        case "androidInstallProcessFinished":
          setAndroidImages(message.availableImages);
          setInstalledAndroidImages(message.installedImages);
          break;
      }
    };

    vscode.postMessage({
      command: "listAllAndroidImages",
    });

    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, []);

  const processAndroidImageChanges = useCallback(
    ({
      toInstall,
      toRemove,
    }: {
      toInstall?: AndroidSystemImage[];
      toRemove?: AndroidSystemImage[];
    }) => {
      setLoading(true);
      vscode.postMessage({
        command: "processAndroidImageChanges",
        toRemove: toRemove ?? [],
        toInstall: toInstall ?? [],
      });

      return new Promise<void>((resolve) => {
        const finishListener = (event: any) => {
          if (event.data.command === "androidInstallProcessFinished") {
            window.removeEventListener("message", finishListener);
            setLoading(false);
            resolve();
          }
        };
        window.addEventListener("message", finishListener);
      });
    },
    []
  );

  const isDeviceImageInstalled = useCallback(
    (device?: Device) => {
      if (!device) {
        return true;
      }
      if (device.platform === PLATFORM.ANDROID) {
        if (!device.systemImage) {
          return false;
        }
        return !!installedAndroidImages.find(
          (androidImage) => androidImage.path === device.systemImage?.path
        );
      } else if (device.platform === PLATFORM.IOS) {
        if (!device.runtime) {
          return false;
        }
        // TODO: check if the present runtime is installed on host machine.
      }
      return true;
    },
    [installedAndroidImages]
  );

  const processIosRuntimeChanges = useCallback(
    ({ toInstall, toRemove }: { toInstall?: string[]; toRemove?: IosRuntime[] }) => {
      setLoading(true);
      vscode.postMessage({
        command: "processIosRuntimeChanges",
        toRemove: toRemove ?? [],
        toInstall: toInstall ?? [],
      });

      return new Promise<void>((resolve) => {
        const finishListener = (event: any) => {
          if (event.data.command === "iOSInstallProcessFinished") {
            window.removeEventListener("message", finishListener);
            setLoading(false);
            resolve();
          }
        };
        window.addEventListener("message", finishListener);
      });
    },
    []
  );

  const removeDeviceWithImage = useCallback(
    async (device: Device) => {
      if (device?.platform === PLATFORM.ANDROID && device.systemImage) {
        processAndroidImageChanges({ toRemove: [device.systemImage] });
      } else if (device?.platform === PLATFORM.IOS && device.runtime) {
        processIosRuntimeChanges({ toRemove: [device.runtime] });
      }
    },
    [processAndroidImageChanges, processIosRuntimeChanges]
  );

  const value = useMemo(
    () => ({
      androidImages,
      installedAndroidImages,
      androidInstallationOutputStream,
      loading,
      processAndroidImageChanges,
      processIosRuntimeChanges,
      removeDeviceWithImage,
      isDeviceImageInstalled,
    }),
    [
      androidImages,
      installedAndroidImages,
      androidInstallationOutputStream,
      loading,
      processAndroidImageChanges,
      processIosRuntimeChanges,
      removeDeviceWithImage,
      isDeviceImageInstalled,
    ]
  );

  return <SystemImagesContext.Provider value={value}>{children}</SystemImagesContext.Provider>;
}

export const useSystemImagesContext = () => {
  const context = useContext(SystemImagesContext);

  if (context === undefined) {
    throw new Error("useSystemImagesContext must be used within a SystemImagesProvider");
  }

  return context;
};
