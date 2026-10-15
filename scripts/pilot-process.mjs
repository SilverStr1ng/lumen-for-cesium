import { spawn, execFile } from "node:child_process";

// Only terminates this invocation's child tree, never an existing browser/server.
export async function runBounded(
  file,
  args,
  { timeoutMilliseconds, forward = false, ...options },
) {
  const child = spawn(file, args, {
    ...options,
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  const chunks = [];
  let timedOut = false;
  const capture = (stream, target) =>
    stream?.on("data", (b) => {
      chunks.push(b);
      if (forward) target.write(b);
    });
  capture(child.stdout, process.stdout);
  capture(child.stderr, process.stderr);
  const closed = new Promise((resolve) => {
    child.on("error", (e) => {
      chunks.push(Buffer.from(String(e)));
      resolve(1);
    });
    child.on("close", (c) => resolve(c ?? 1));
  });
  let timer;
  let exitCode = await Promise.race([
    closed,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve("deadline"), timeoutMilliseconds);
    }),
  ]);
  clearTimeout(timer);
  let cleanupFailed = false;
  if (exitCode === "deadline") {
    timedOut = true;
    chunks.push(
      Buffer.from(`\nChild deadline exceeded: ${timeoutMilliseconds}ms\n`),
    );
    if (child.pid && process.platform === "win32") {
      const error = await new Promise((resolve) =>
        execFile(
          "taskkill",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, timeout: 5000 },
          (error) => resolve(error),
        ),
      );
      if (error) {
        cleanupFailed = true;
        chunks.push(
          Buffer.from("Child tree termination failed: " + String(error)),
        );
        child.kill("SIGKILL");
      }
    } else if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        cleanupFailed = true;
        chunks.push(Buffer.from(String(error)));
        child.kill("SIGKILL");
      }
    }
    exitCode = await Promise.race([
      closed,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("cleanup-deadline"), 2000);
      }),
    ]);
    clearTimeout(timer);
    if (exitCode === "cleanup-deadline") {
      cleanupFailed = true;
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      child.unref();
    }
  }
  return {
    exitCode: timedOut ? 1 : exitCode,
    timedOut,
    cleanupFailed,
    log: Buffer.concat(chunks),
  };
}
