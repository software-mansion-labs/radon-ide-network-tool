import fs from "fs";
import path from "path";
import semver from "semver";
import { OutputChannel } from "vscode";
import loadConfig from "@react-native-community/cli-config";
import { getNativeABI } from "../utilities/common";
import { ANDROID_HOME, findJavaHome } from "../utilities/android";
import { Logger } from "../Logger";
import { exec, lineReader } from "../utilities/subprocess";
import { CancelToken } from "./cancelToken";
import { extensionContext } from "../utilities/extensionContext";
import { BuildAndroidProgressProcessor } from "./BuildAndroidProgressProcessor";
import { getLaunchConfiguration } from "../utilities/launchConfiguration";
import { EXPO_GO_PACKAGE_NAME, downloadExpoGo, isExpoGoProject } from "./expoGo";
import { DevicePlatform } from "../common/DeviceManager";
import { getReactNativeVersion } from "../utilities/reactNative";
import { runExternalBuild } from "./customBuild";
import { fetchEasBuild } from "./eas";
import { DependencyManager } from "../dependency/DependencyManager";
import { getTelemetryReporter } from "../utilities/telemetry";

export type AndroidBuildResult = {
  platform: DevicePlatform.Android;
  apkPath: string;
  packageName: string;
};

const BUILD_TOOLS_PATH = path.join(ANDROID_HOME, "build-tools");
const RELATIVE_APK_DIR = "app/build/outputs/apk";

// Assuming users have android folder in their project's root
export const getAndroidSourceDir = (appRootFolder: string) => path.join(appRootFolder, "android");

function locateAapt() {
  // search for aapt binary under BUILD_TOOLS_PATH/<version>/aapt
  // since we only need aapt to extract package name, we can use any version.
  // However, on M1 macs, aapt we noticed that older aapt versions may not work
  // as they may require rosetta, so we try to find the latest version.
  const versions = fs.readdirSync(BUILD_TOOLS_PATH);
  const latestVersion = versions.sort().reverse()[0];
  return path.join(BUILD_TOOLS_PATH, latestVersion, "aapt");
}

async function extractPackageName(artifactPath: string, cancelToken: CancelToken) {
  const aaptPath = locateAapt();
  const { stdout } = await cancelToken.adapt(exec(aaptPath, ["dump", "badging", artifactPath]));
  const packageLine = stdout.split("\n").find((line: string) => line.startsWith("package: name="));
  const packageName = packageLine!.split("'")[1];
  return packageName;
}

function getApkPath(appRootFolder: string, productFlavor: string, buildType: string) {
  const androidSourceDir = getAndroidSourceDir(appRootFolder);
  const apkFile = ["app", productFlavor, buildType].filter(Boolean).join("-") + ".apk";
  return path.join(androidSourceDir, RELATIVE_APK_DIR, productFlavor, buildType, apkFile);
}

export async function getAndroidBuildPaths(
  appRootFolder: string,
  cancelToken: CancelToken,
  productFlavor: string,
  buildType: string
) {
  const apkPath = getApkPath(appRootFolder, productFlavor, buildType);
  const packageName = await extractPackageName(apkPath, cancelToken);
  return { apkPath, packageName };
}

function makeBuildTaskName(productFlavor: string, buildType: string, appName?: string) {
  // task name is in the format of :<appName>:assemble<ProductFlavor><BuildType> where productFlavor and buildType
  // are the names of the productFlavor and buildType that each start with a capital letter.
  // By default, Android Gradle Plugin always creates staging and release buildTypes and does not define any productFlavor.
  // and appName is the name of the application as seen by the gradle build system, omitting appName leads to
  // whole android project being build.
  const flavorUppercase =
    productFlavor && productFlavor.charAt(0).toUpperCase() + productFlavor.slice(1);
  const buildTypeUppercase = buildType && buildType.charAt(0).toUpperCase() + buildType.slice(1);
  const prefix = appName ? `:${appName}:` : "";
  return `${prefix}assemble${flavorUppercase}${buildTypeUppercase}`;
}

export async function buildAndroid(
  appRoot: string,
  forceCleanBuild: boolean,
  cancelToken: CancelToken,
  outputChannel: OutputChannel,
  progressListener: (newProgress: number) => void,
  dependencyManager: DependencyManager
): Promise<AndroidBuildResult> {
  const { customBuild, eas, env, android } = getLaunchConfiguration();

  if (customBuild?.android && eas?.android) {
    throw new Error(
      "Both custom custom builds and EAS builds are configured for Android. Please use only one build method."
    );
  }

  if (customBuild?.android?.buildCommand) {
    getTelemetryReporter().sendTelemetryEvent("build:custom-build-requested", {
      platform: DevicePlatform.Android,
    });
    const apkPath = await runExternalBuild(
      cancelToken,
      customBuild.android.buildCommand,
      env,
      DevicePlatform.Android,
      appRoot
    );
    if (!apkPath) {
      throw new Error("Failed to build Android app using custom script.");
    }

    return {
      apkPath,
      packageName: await extractPackageName(apkPath, cancelToken),
      platform: DevicePlatform.Android,
    };
  }

  if (eas?.android) {
    getTelemetryReporter().sendTelemetryEvent("build:eas-build-requested", {
      platform: DevicePlatform.Android,
    });
    const apkPath = await fetchEasBuild(
      cancelToken,
      eas.android,
      DevicePlatform.Android,
      appRoot,
      outputChannel
    );

    return {
      apkPath,
      packageName: await extractPackageName(apkPath, cancelToken),
      platform: DevicePlatform.Android,
    };
  }

  if (await isExpoGoProject(appRoot)) {
    getTelemetryReporter().sendTelemetryEvent("build:expo-go-requested", {
      platform: DevicePlatform.Android,
    });
    const apkPath = await downloadExpoGo(DevicePlatform.Android, cancelToken, appRoot);
    return { apkPath, packageName: EXPO_GO_PACKAGE_NAME, platform: DevicePlatform.Android };
  }

  if (!(await dependencyManager.checkAndroidDirectoryExits())) {
    throw new Error(
      '"android" directory does not exist, configure build source in launch configuration or use expo prebuild to generate the directory'
    );
  }

  const androidSourceDir = getAndroidSourceDir(appRoot);
  const androidAppName = loadConfig({
    projectRoot: appRoot,
    selectedPlatform: "android",
  }).platforms.android?.projectConfig(appRoot)?.appName;
  const productFlavor = android?.productFlavor || "";
  const buildType = android?.buildType || "debug";
  const gradleArgs = [
    "-x",
    "lint",
    `-PreactNativeArchitectures=${getNativeABI()}`,
    ...(forceCleanBuild ? ["clean"] : []),
    makeBuildTaskName(productFlavor, buildType, androidAppName),
    "--init-script", // buildProgressEvaluation init script is used log build task count for build progress logging
    path.join(
      extensionContext.extensionPath,
      "lib",
      "android",
      "buildProgressEvaluation.initscript.gradle"
    ),
  ];
  // configureReactNativeOverrides init script is only necessary for RN versions older then 0.74.0 see comments in configureReactNativeOverrides.gradle for more details
  if (semver.lt(getReactNativeVersion(appRoot), "0.74.0")) {
    gradleArgs.push(
      "--init-script", // configureReactNativeOverrides init script is used to patch React Android project, see comments in configureReactNativeOverrides.gradle for more details
      path.join(
        extensionContext.extensionPath,
        "lib",
        "android",
        "configureReactNativeOverrides.initscript.gradle"
      )
    );
  }
  Logger.debug("Starting Android build");
  const JAVA_HOME = await findJavaHome();
  const buildProcess = cancelToken.adapt(
    exec("./gradlew", gradleArgs, {
      cwd: androidSourceDir,
      env: { JAVA_HOME, ANDROID_HOME, ...env },
      buffer: false,
    })
  );
  const buildAndroidProgressProcessor = new BuildAndroidProgressProcessor(progressListener);
  lineReader(buildProcess).onLineRead((line) => {
    outputChannel.appendLine(line);
    buildAndroidProgressProcessor.processLine(line);
  });

  await buildProcess;
  Logger.debug("Android build successful");
  const apkInfo = await getAndroidBuildPaths(appRoot, cancelToken, productFlavor, buildType);
  return { ...apkInfo, platform: DevicePlatform.Android };
}
