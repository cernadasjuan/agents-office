#!/usr/bin/env node
// Called by scripts/install-launcher.sh so the install step and the launcher share one
// implementation of "create the config file if it does not exist" (config.mjs).

import { configPath, ensureConfig } from './config.mjs';

const created = ensureConfig();
const file = configPath();
console.log(created ? `Created config file: ${file}` : `Config file already exists: ${file}`);
