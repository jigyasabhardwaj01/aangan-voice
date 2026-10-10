import { readFileSync, writeFileSync } from "node:fs";
import { buildVoiceContext } from "../src/voice/context";

writeFileSync("vaani/voice-context.txt", buildVoiceContext(readFileSync("vaani/system-prompt.md", "utf8")));
console.log("wrote vaani/voice-context.txt");
