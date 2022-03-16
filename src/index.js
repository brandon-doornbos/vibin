import { spawn } from 'child_process';
import config from "../config.json" assert { type: "json" };

spawn("node", ["src/bot.js", config.token_1], { stdio: 'inherit' });
// spawn("node", ["src/bot.js", config.token_2], { stdio: 'inherit' });
