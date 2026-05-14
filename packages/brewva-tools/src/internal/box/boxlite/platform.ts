import { existsSync } from "node:fs";
import { BoxPlaneError } from "../errors.js";

export function preflightBoxLitePlatform(): void {
  if (process.platform === "linux" && !existsSync("/dev/kvm")) {
    throw new BoxPlaneError(
      "BoxLite backend requires /dev/kvm on Linux. Enable KVM or choose security.execution.backend='host' outside strict mode.",
      "box_unavailable",
      { platform: process.platform },
    );
  }
  if (
    !(
      (process.platform === "darwin" && process.arch === "arm64") ||
      (process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64"))
    )
  ) {
    throw new BoxPlaneError(
      `BoxLite backend is not packaged for ${process.platform}-${process.arch}`,
      "box_unavailable",
      { platform: process.platform, arch: process.arch },
    );
  }
}
