@echo off
rem WI01 standalone entrypoint (does not touch GoRouter product state)
bun "%~dp0src\cli.ts" %*
