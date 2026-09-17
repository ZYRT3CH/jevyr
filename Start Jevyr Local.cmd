@echo off
setlocal
set "JEVYR_SELF_JUDGE=1"
set "JEVYR_SELF_JUDGE_INTERVAL_MS=60000"
rem A saved visual selection takes precedence over this machine's starter profile.
if exist "%~dp0.jevyr\connections.json" goto saved_profile
rem This starter profile uses two locally installed Ollama model families.
rem Provider quality is limited; see docs\ds-judge-gates.md for measured results.
set "JEVYR_OLLAMA_BASE_URL=http://127.0.0.1:11434/v1/"
set "JEVYR_OLLAMA_MODEL_FAMILY=qwen"
set "JEVYR_OLLAMA_INVESTIGATION_TRANSPORT=native"
set "JEVYR_OPENAI_COMPATIBLE_MODEL=gpt-oss:20b"
set "JEVYR_OPENAI_COMPATIBLE_BASE_URL=http://127.0.0.1:11434/v1/"
set "JEVYR_OPENAI_COMPATIBLE_MODEL_FAMILY=gpt-oss"
set "JEVYR_OPENAI_COMPATIBLE_INVESTIGATION_TRANSPORT=structured"
set "JEVYR_OPENAI_COMPATIBLE_CREDENTIAL_REF="
set "JEVYR_OPENAI_COMPATIBLE_API_KEY="
call "%~dp0Start Jevyr.cmd" --local-model qwen3-coder:30b-32k %*
exit /b %errorlevel%

:saved_profile
call "%~dp0Start Jevyr.cmd" %*
exit /b %errorlevel%
