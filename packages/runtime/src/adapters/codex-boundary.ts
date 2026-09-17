import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { digestJson, type JsonValue } from "@jevyr/protocol";
import { INVESTIGATOR_TOOL_DEFINITIONS, INVESTIGATOR_TOOL_POLICY } from "../investigator-tools.js";

export const CODEX_PERMISSION_PROFILE="jevyr-sealed-context";
export const CODEX_BOUNDARY_VERSION="jevyr.codex-agent-boundary/1";
// Pin the verified native protocol family; a different installation must be
// measured before it can gain this capability through a silent update.
export const CODEX_NATIVE_VERSION="0.153.1";
export const CODEX_DISABLED_FEATURES=Object.freeze(["shell_tool","unified_exec","shell_snapshot","shell_snapshot_v2","apply_patch_freeform","apps","connectors","plugins","remote_plugin","plugin_hooks","hooks","codex_hooks","skill_search","skill_mcp_dependency_install","skill_env_var_dependency_prompt","browser_use","browser_use_external","computer_use","js_repl","code_mode","code_mode_host","multi_agent","multi_agent_v2","collab","memories","memory_tool","image_generation","imagegenext","view_image","search_tool","tool_search","tool_suggest","request_permissions","request_permissions_tool","request_rule","default_mode_request_user_input","goals","sleep_tool","remote_control","workspace_dependencies","executor_capability_discovery","recommended_plugins","remote_models"]);
export const CODEX_BOUNDARY_DESCRIPTOR=Object.freeze({protocol:CODEX_BOUNDARY_VERSION,nativeVersion:CODEX_NATIVE_VERSION,permissionProfile:CODEX_PERMISSION_PROFILE,hostTools:[],disabledFeatures:CODEX_DISABLED_FEATURES,ambientHome:false,ambientEnvironment:false,ambientCredentials:false,contextTools:INVESTIGATOR_TOOL_DEFINITIONS.map(tool=>tool.function.name),toolPolicy:INVESTIGATOR_TOOL_POLICY});
export const CODEX_BOUNDARY_DIGEST=digestJson(CODEX_BOUNDARY_DESCRIPTOR as unknown as JsonValue);

export function codexChildEnvironment(home:string,cwd:string,source:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv {
  const environment:NodeJS.ProcessEnv={};
  for(const key of ["PATH","Path","SystemRoot","WINDIR","COMSPEC","PATHEXT","LANG","LC_ALL"])if(source[key])environment[key]=source[key];
  return{...environment,HOME:home,USERPROFILE:home,CODEX_HOME:home,PWD:cwd,TEMP:home,TMP:home,TMPDIR:home,XDG_CONFIG_HOME:home,XDG_CACHE_HOME:home,APPDATA:home,LOCALAPPDATA:home};
}
/** All JSON is local fixed configuration; no user TOML or model text is accepted. */
function toml(value:JsonValue):string {
  if(typeof value==="string"||typeof value==="number"||typeof value==="boolean")return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(toml).join(", ")}]`;
  if(value&&typeof value==="object")return `{ ${Object.entries(value).map(([key,item])=>`${JSON.stringify(key)} = ${toml(item)}`).join(", ")} }`;
  throw new Error("Null is not a Codex boundary setting");
}
export function codexBoundaryConfig(cwd:string):Record<string,JsonValue> {
  return{approval_policy:"never",default_permissions:CODEX_PERMISSION_PROFILE,model_provider:"openai",web_search:"disabled",project_doc_max_bytes:0,project_doc_fallback_filenames:[],hide_agent_reasoning:true,include_apps_instructions:false,
    history:{persistence:"none"},analytics:{enabled:false},feedback:{enabled:false},mcp_servers:{},plugins:{},hooks:{},model_providers:{},
    tools:{experimental_request_user_input:{enabled:false},update_plan:{enabled:false}},
    features:{...Object.fromEntries(CODEX_DISABLED_FEATURES.map(key=>[key,false])),tool_registry:{error_on_tool_collisions:true,turn_metadata_includes_tool_info:true},skip_host_skill_discovery:true},
    permissions:{[CODEX_PERMISSION_PROFILE]:{filesystem:{":minimal":"read",[resolve(cwd)]:"read"},network:{enabled:false},workspace_roots:{[resolve(cwd)]:true}}},
    allow_login_shell:false,include_environment_context:false,shell_environment_policy:{inherit:"none",ignore_default_excludes:false},
    windows:{sandbox:"unelevated"}};
}
export async function prepareCodexBoundary(root:string):Promise<{home:string;cwd:string;config:Record<string,JsonValue>}> {
  const home=join(root,"home"),cwd=join(root,"context");await mkdir(home);await mkdir(cwd);
  const config=codexBoundaryConfig(cwd);
  await writeFile(join(home,"config.toml"),Object.entries(config).map(([key,value])=>`${key} = ${toml(value)}`).join("\n")+"\n",{flag:"wx",mode:0o600});
  return{home,cwd,config};
}
export function assertCodexThreadBoundary(value:unknown,cwd:string,model:string):asserts value is {thread:{id:string}} {
  const response=value as {activePermissionProfile?:{id?:string;extends?:unknown};approvalPolicy?:unknown;cwd?:unknown;model?:unknown;modelProvider?:unknown;instructionSources?:unknown;runtimeWorkspaceRoots?:unknown;thread?:{id?:unknown}};
  if(!response||response.activePermissionProfile?.id!==CODEX_PERMISSION_PROFILE||response.activePermissionProfile.extends!=null||response.approvalPolicy!=="never"||response.cwd!==cwd||response.model!==model||response.modelProvider!=="openai"
    ||!Array.isArray(response.instructionSources)||response.instructionSources.length!==0||!Array.isArray(response.runtimeWorkspaceRoots)||response.runtimeWorkspaceRoots.length!==0||typeof response.thread?.id!=="string"||!response.thread.id)throw new Error("Codex did not acknowledge the exact sealed context boundary");
}

export function assertCodexConfiguration(value:unknown,cwd:string):void {
  const config=(value as {config?:Record<string,any>})?.config;
  const fail=()=>{throw new Error("Codex effective configuration differs from the sealed context boundary");};
  if(!config||config.default_permissions!==CODEX_PERMISSION_PROFILE||config.approval_policy!=="never"||config.model_provider!=="openai"||config.web_search!=="disabled"||config.project_doc_max_bytes!==0||config.allow_login_shell!==false||config.include_environment_context!==false||config.history?.persistence!=="none")fail();
  for(const key of CODEX_DISABLED_FEATURES)if(config!.features?.[key]!==false)fail();
  if(config!.features?.skip_host_skill_discovery!==true||config!.features?.tool_registry?.error_on_tool_collisions!==true)fail();
  for(const key of ["mcp_servers","plugins","model_providers"])if(!config![key]||Object.keys(config![key]).length!==0)fail();
  for(const key of ["instructions","developer_instructions","model_instructions_file","notify","openai_base_url","agents"])if(config![key]!=null)fail();
  if(Object.values(config!.hooks??{}).some(value=>!Array.isArray(value)||value.length!==0))fail();
  const profiles=config!.permissions,profile=profiles?.[CODEX_PERMISSION_PROFILE];
  if(!profile||Object.keys(profiles).length!==1||profile.extends!=null||profile.network?.enabled!==false||profile.network.domains!=null||profile.network.unix_sockets!=null)fail();
  const filesystem=profile.filesystem;
  if(filesystem?.[":minimal"]!=="read"||filesystem[resolve(cwd)]!=="read"||Object.entries(filesystem).some(([key,value])=>!([":minimal",resolve(cwd)].includes(key)||key==="glob_scan_max_depth"&&value===null)))fail();
}
