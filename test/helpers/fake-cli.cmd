@ECHO off
:: fake-cli.mjs as a Windows command. Windows cannot spawn a script by its
:: shebang, so on Windows the conformance suite points harnesses here: a shim in
:: the shape npm installs for any Node CLI. Relay never runs it through cmd.exe;
:: it reads the line below, sees node and the script beside this file, and
:: spawns node on that script directly - exactly as it runs an npm-installed
:: claude.cmd or codex.cmd.
"node"  "%~dp0\fake-cli.mjs" %*
