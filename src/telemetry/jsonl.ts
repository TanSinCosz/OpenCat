import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { EvaluationEvent } from "./events.js";
import type { RunObserver } from "./observer.js";

export class JsonlRunObserver implements RunObserver {
  constructor(private readonly filePath: string) {}

  async emit(event: EvaluationEvent): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
  }
}

