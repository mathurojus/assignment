@echo off
REM ---------------------------------------------------------------------------
REM canary.cmd - send the 8x capture canary prompt into a fresh session.
REM
REM This is a .cmd file on purpose. `opencode run "msg"` and
REM `opencode api --data '{...}'` both go through PowerShell, which strips and
REM re-adds double quotes on the way into the Bun executable. That mangled the
REM canary into a literal `"CAPTURE TEST ..."` with the quotes baked into the
REM prompt text. Routing through cmd.exe passes the JSON body intact.
REM
REM The prompt hook fires at admission, i.e. before the provider call, so the
REM PROMPT entry is captured even when the model call then fails.
REM
REM Usage:  cmd /c scripts\canary.cmd [session-id]
REM ---------------------------------------------------------------------------
setlocal
set SID=%~1
if "%SID%"=="" set SID=ses_canary00000001

echo Creating session %SID% ...
for /f "delims=" %%i in ('opencode api post /api/session --data "{\"location\":{\"directory\":\"C:/Users/Ojus/Desktop/assign\"},\"id\":\"%SID%\"}"') do echo %%i

echo Sending canary prompt ...
opencode api post /api/session/%SID%/prompt --data "{\"text\":\"CAPTURE TEST - 8x assignment, Ojus\"}"

echo Done. Log: .agent-logs\*%SID%.md
endlocal
