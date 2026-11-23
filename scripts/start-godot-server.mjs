import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const projectPath = path.join(projectRoot, "godot-game1-websocket");
const configuredExecutable = process.env.GODOT_BIN;
const executables = configuredExecutable
  ? [configuredExecutable]
  : process.platform === "win32"
    ? ["godot.exe", "godot4.exe", "godot"]
    : ["godot", "godot4"];

function launch(executableIndex) {
  if (executableIndex >= executables.length) {
    console.warn("Godot was not found. Install it or set GODOT_BIN; continuing without the sample game's LAN server.");
    return;
  }

  const executable = executables[executableIndex];
  const child = spawn(executable, ["--headless", "--path", projectPath, "--", "--server"], {
    cwd: projectRoot,
    stdio: "inherit"
  });

  child.once("error", (error) => {
    if (error.code === "ENOENT" && !configuredExecutable) {
      launch(executableIndex + 1);
      return;
    }
    console.error(`Could not start Godot server using "${executable}": ${error.message}`);
    process.exitCode = 1;
  });

  child.once("exit", (code, signal) => {
    if (signal) {
      process.exitCode = 1;
    } else if (code !== 0) {
      process.exitCode = code || 1;
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => child.kill(signal));
  }
}

launch(0);
