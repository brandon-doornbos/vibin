import { spawn } from "child_process";
import tokens from "./config.json" assert { type: "json" };

spawn("node", ["dist/bot.js", tokens[0]], { stdio: "inherit" });
spawn("node", ["dist/bot.js", tokens[1]], { stdio: "inherit" });
