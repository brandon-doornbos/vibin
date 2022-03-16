import { spawn } from "child_process";
import { tokens } from "../config.json" assert { type: "json" };

spawn("node", ["src/bot.js", tokens[0]], { stdio: "inherit" });
// spawn("node", ["src/bot.js", tokens[1]], { stdio: "inherit" });
