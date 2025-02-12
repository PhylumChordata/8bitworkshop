
/// <reference types="emscripten" />
import type { WorkerResult, WorkerFileUpdate, WorkerBuildStep, WorkerMessage, WorkerError, Dependency, SourceLine, CodeListing, CodeListingMap, Segment, WorkerOutput, SourceLocation } from "../common/workertypes";
import { getBasePlatform, getRootBasePlatform, hex } from "../common/util";
import { Assembler } from "./assembler";

interface EmscriptenModule {
  callMain: (args: string[]) => void;
  FS : any; // TODO
}

declare function importScripts(path:string);
declare function postMessage(msg);

const ENVIRONMENT_IS_WEB = typeof window === 'object';
const ENVIRONMENT_IS_WORKER = typeof importScripts === 'function';
const emglobal : any = ENVIRONMENT_IS_WORKER ? self : ENVIRONMENT_IS_WEB ? window : global;

// simple CommonJS module loader
// TODO: relative paths for dependencies
if (!emglobal['require']) {
  emglobal['require'] = (modpath: string) => {
    if (modpath.endsWith('.js')) modpath = modpath.slice(-3);
    var modname = modpath.split('/').slice(-1)[0];
    var hasNamespace = emglobal[modname] != null;
    console.log('@@@ require', modname, modpath, hasNamespace);
    if (!hasNamespace) {
      exports = {};
      importScripts(`${modpath}.js`);
    }
    if (emglobal[modname] == null) {
      emglobal[modname] = exports; // TODO: always put in global scope?
    }
    return emglobal[modname]; // TODO
  }
}

// WebAssembly module cache
// TODO: leaks memory even when disabled...
var _WASM_module_cache = {};
var CACHE_WASM_MODULES = true; // if false, use asm.js only

// TODO: which modules need this?
var wasmMemory;
function getWASMMemory() {
    if (wasmMemory == null) {
      wasmMemory = new WebAssembly.Memory({
        'initial': 1024,  // 64MB
        'maximum': 16384, // 1024MB
      });
    }
    return wasmMemory;
}

function getWASMModule(module_id:string) {
  var module = _WASM_module_cache[module_id];
  if (!module) {
    starttime();
    module = new WebAssembly.Module(wasmBlob[module_id]);
    if (CACHE_WASM_MODULES) {
      _WASM_module_cache[module_id] = module;
      delete wasmBlob[module_id];
    }
    endtime("module creation " + module_id);
  }
  return module;
}
// function for use with instantiateWasm
function moduleInstFn(module_id:string) {
  return function(imports,ri) {
    var mod = getWASMModule(module_id);
    var inst = new WebAssembly.Instance(mod, imports);
    ri(inst);
    return inst.exports;
  }
}

//

var PLATFORM_PARAMS = {
  'vcs': {
    arch: '6502',
    code_start: 0x1000,
    code_size: 0xf000,
    data_start: 0x80,
    data_size: 0x80,
    wiz_rom_ext: '.a26',
    wiz_inc_dir: '2600',
    extra_link_files: ['atari2600.cfg'],
    cfgfile: 'atari2600.cfg',
  },
  'mw8080bw': {
    arch: 'z80',
    code_start: 0x0,
    rom_size: 0x2000,
    data_start: 0x2000,
    data_size: 0x400,
    stack_end: 0x2400,
  },
  'vicdual': {
    arch: 'z80',
    code_start: 0x0,
    rom_size: 0x4020,
    data_start: 0xe400,
    data_size: 0x400,
    stack_end: 0xe800,
  },
  'galaxian': {
    arch: 'z80',
    code_start: 0x0,
    rom_size: 0x4000,
    data_start: 0x4000,
    data_size: 0x400,
    stack_end: 0x4800,
  },
  'galaxian-scramble': {
    arch: 'z80',
    code_start: 0x0,
    rom_size: 0x5020,
    data_start: 0x4000,
    data_size: 0x400,
    stack_end: 0x4800,
  },
  'williams': {
    arch: '6809',
    code_start: 0x0,
    rom_size: 0xc000,
    data_start: 0x9800,
    data_size: 0x2800,
    stack_end: 0xc000,
    //extra_compile_args: ['--vectrex'],
    extra_link_files: ['williams.scr', 'libcmoc-crt-vec.a', 'libcmoc-std-vec.a'],
    extra_link_args: ['-swilliams.scr', '-lcmoc-crt-vec', '-lcmoc-std-vec'],
  },
  'williams-z80': {
    arch: 'z80',
    code_start: 0x0,
    rom_size: 0x9800,
    data_start: 0x9800,
    data_size: 0x2800,
    stack_end: 0xc000,
  },
  'vector-z80color': {
    arch: 'z80',
    code_start: 0x0,
    rom_size: 0x8000,
    data_start: 0xe000,
    data_size: 0x2000,
    stack_end: 0x0,
  },
  'vector-ataricolor': { //TODO
    arch: '6502',
    define: ['__VECTOR__'],
    cfgfile: 'vector-color.cfg',
    libargs: ['crt0.o', 'sim6502.lib'],
    extra_link_files: ['crt0.o', 'vector-color.cfg'],
  },
  'sound_williams-z80': {
    arch: 'z80',
    code_start: 0x0,
    rom_size: 0x4000,
    data_start: 0x4000,
    data_size: 0x400,
    stack_end: 0x8000,
  },
  'base_z80': {
    arch: 'z80',
    code_start: 0x0,
    rom_size: 0x8000,
    data_start: 0x8000,
    data_size: 0x8000,
    stack_end: 0x0,
  },
  'coleco': {
    arch: 'z80',
    rom_start: 0x8000,
    code_start: 0x8100,
    rom_size: 0x8000,
    data_start: 0x7000,
    data_size: 0x400,
    stack_end: 0x8000,
    extra_preproc_args: ['-I', '/share/include/coleco', '-D', 'CV_CV'],
    extra_link_args: ['-k', '/share/lib/coleco', '-l', 'libcv', '-l', 'libcvu', 'crt0.rel'],
  },
  'msx': {
    arch: 'z80',
    rom_start: 0x4000,
    code_start: 0x4000,
    rom_size: 0x8000,
    data_start: 0xc000,
    data_size: 0x3000,
    stack_end: 0xffff,
    extra_link_args: ['crt0-msx.rel'],
    extra_link_files: ['crt0-msx.rel', 'crt0-msx.lst'],
    wiz_sys_type: 'z80',
    wiz_inc_dir: 'msx',
  },
  'msx-libcv': {
    arch: 'z80',
    rom_start: 0x4000,
    code_start: 0x4000,
    rom_size: 0x8000,
    data_start: 0xc000,
    data_size: 0x3000,
    stack_end: 0xffff,
    extra_preproc_args: ['-I', '.', '-D', 'CV_MSX'],
    extra_link_args: ['-k', '.', '-l', 'libcv-msx', '-l', 'libcvu-msx', 'crt0-msx.rel'],
    extra_link_files: ['libcv-msx.lib', 'libcvu-msx.lib', 'crt0-msx.rel', 'crt0-msx.lst'],
    extra_compile_files: ['cv.h','cv_graphics.h','cv_input.h','cv_sound.h','cv_support.h','cvu.h','cvu_c.h','cvu_compression.h','cvu_f.h','cvu_graphics.h','cvu_input.h','cvu_sound.h'],
  },
  'sms-sg1000-libcv': {
    arch: 'z80',
    rom_start: 0x0000,
    code_start: 0x0100,
    rom_size: 0xc000,
    data_start: 0xc000,
    data_size: 0x400,
    stack_end: 0xe000,
    extra_preproc_args: ['-I', '.', '-D', 'CV_SMS'],
    extra_link_args: ['-k', '.', '-l', 'libcv-sms', '-l', 'libcvu-sms', 'crt0-sms.rel'],
    extra_link_files: ['libcv-sms.lib', 'libcvu-sms.lib', 'crt0-sms.rel', 'crt0-sms.lst'],
    extra_compile_files: ['cv.h','cv_graphics.h','cv_input.h','cv_sound.h','cv_support.h','cvu.h','cvu_c.h','cvu_compression.h','cvu_f.h','cvu_graphics.h','cvu_input.h','cvu_sound.h'],
  },
  'nes': { //TODO
    arch: '6502',
    define: ['__NES__'],
    cfgfile: 'neslib2.cfg',
    libargs: ['crt0.o', 'nes.lib', 'neslib2.lib',
      '-D', 'NES_MAPPER=0', // NROM
      '-D', 'NES_PRG_BANKS=2', // 2 16K PRG banks
      '-D', 'NES_CHR_BANKS=1', // 1 CHR bank
      '-D', 'NES_MIRRORING=0', // horizontal mirroring
      ],
    extra_link_files: ['crt0.o', 'neslib2.lib', 'neslib2.cfg', 'nesbanked.cfg'],
    wiz_rom_ext: '.nes',
  },
  'apple2': {
    arch: '6502',
    define: ['__APPLE2__'],
    cfgfile: 'apple2-hgr.cfg',
    libargs: [ '--lib-path', '/share/target/apple2/drv', '-D', '__EXEHDR__=0', 'apple2.lib'],
    __CODE_RUN__: 16384,
    code_start: 0x803,
  },
  'apple2-e': {
    arch: '6502',
    define: ['__APPLE2__'],
    cfgfile: 'apple2.cfg',
    libargs: ['apple2.lib'],
  },
  'atari8-800xl.disk': {
    arch: '6502',
    define: ['__ATARI__'],
    cfgfile: 'atari.cfg',
    libargs: ['atari.lib'],
    fastbasic_cfgfile: 'fastbasic-cart.cfg',
  },
  'atari8-800xl': {
    arch: '6502',
    define: ['__ATARI__'],
    cfgfile: 'atari-cart.cfg',
    libargs: ['atari.lib', '-D', '__CARTFLAGS__=4'],
    fastbasic_cfgfile: 'fastbasic-cart.cfg',
  },
  'atari8-5200': {
    arch: '6502',
    define: ['__ATARI5200__'],
    cfgfile: 'atari5200.cfg',
    libargs: ['atari5200.lib', '-D', '__CARTFLAGS__=255'],
    fastbasic_cfgfile: 'fastbasic-cart.cfg',
  },
  'verilog': {
    arch: 'verilog',
    extra_compile_files: ['8bitworkshop.v'],
  },
  'astrocade': {
    arch: 'z80',
    code_start: 0x2000,
      rom_size: 0x2000,
    data_start: 0x4e10,
     data_size: 0x1f0,
     stack_end: 0x5000,
  },
  'astrocade-arcade': {
    arch: 'z80',
    code_start: 0x0000,
      rom_size: 0x4000,
    data_start: 0x7de0,
     data_size: 0x220,
     stack_end: 0x8000,
  },
  'astrocade-bios': {
    arch: 'z80',
    code_start: 0x0000,
      rom_size: 0x2000,
    data_start: 0x4fce,
     data_size: 50,
     stack_end: 0x4fce,
  },
  'atari7800': {
    arch: '6502',
    define: ['__ATARI7800__'],
    cfgfile: 'atari7800.cfg',
    libargs: ['crt0.o', 'sim6502.lib'],
    extra_link_files: ['crt0.o', 'atari7800.cfg'],
  },
  'c64': {
    arch: '6502',
    define: ['__CBM__', '__C64__'],
    cfgfile: 'c64.cfg', // SYS 2061
    libargs: ['c64.lib'],
    //extra_link_files: ['c64-cart.cfg'],
  },
  'kim1': {
    arch: '6502',
  },
  'vectrex': {
    arch: '6809',
    code_start: 0x0,
    rom_size: 0x8000,
    data_start: 0xc880,
    data_size: 0x380,
    stack_end: 0xcc00,
    extra_compile_files: ['assert.h','cmoc.h','stdarg.h','vectrex.h','stdlib.h','bios.h'],
    extra_link_files: ['vectrex.scr', 'libcmoc-crt-vec.a', 'libcmoc-std-vec.a'],
    extra_compile_args: ['--vectrex'],
    extra_link_args: ['-svectrex.scr', '-lcmoc-crt-vec', '-lcmoc-std-vec'],
  },
  'x86': {    
    arch: 'x86',
  },
  'zx': {
    arch: 'z80',
    code_start: 0x5ccb,
      rom_size: 0xff58-0x5ccb,
    data_start: 0xf000,
     data_size: 0xfe00-0xf000,
     stack_end: 0xff58,
     extra_link_args: ['crt0-zx.rel'],
     extra_link_files: ['crt0-zx.rel', 'crt0-zx.lst'],
  },
  'devel-6502': {
    arch: '6502',
    cfgfile: 'devel-6502.cfg',
    libargs: ['crt0.o', 'sim6502.lib'],
    extra_link_files: ['crt0.o', 'devel-6502.cfg'],
  },
};

PLATFORM_PARAMS['sms-sms-libcv'] = PLATFORM_PARAMS['sms-sg1000-libcv'];

var _t1;
function starttime() { _t1 = new Date(); }
function endtime(msg) { var _t2 = new Date(); console.log(msg, _t2.getTime() - _t1.getTime(), "ms"); }

/// working file store and build steps

type FileData = string | Uint8Array;

type FileEntry = {
  path: string
  encoding: string
  data: FileData
  ts: number
};

type BuildOptions = {
  mainFilePath : string,
  processFn?: (s:string, d:FileData) => FileData
};

// TODO
interface BuildStep extends WorkerBuildStep {
  files? : string[]
  args? : string[]
  nextstep? : BuildStep
  linkstep? : BuildStep
  params?
  result? // : WorkerResult | BuildStep ?
  code?
  prefix?
  maxts?
};

///

class FileWorkingStore {
  workfs : {[path:string]:FileEntry} = {};
  workerseq : number = 0;

  constructor() {
    this.reset();
  }
  reset() {
    this.workfs = {};
    this.newVersion();
  }
  currentVersion() {
    return this.workerseq;
  }
  newVersion() {
    let ts = new Date().getTime();
    if (ts <= this.workerseq)
      ts = ++this.workerseq;
    return ts;
  }
  putFile(path:string, data:FileData) : FileEntry {
    var encoding = (typeof data === 'string') ? 'utf8' : 'binary';
    var entry = this.workfs[path];
    if (!entry || !compareData(entry.data, data) || entry.encoding != encoding) {
      this.workfs[path] = entry = {path:path, data:data, encoding:encoding, ts:this.newVersion()};
      console.log('+++', entry.path, entry.encoding, entry.data.length, entry.ts);
    }
    return entry;
  }
  hasFile(path: string) {
    return this.workfs[path] != null;
  }
  getFileData(path:string) : FileData {
    return this.workfs[path] && this.workfs[path].data;
  }  
  getFileAsString(path:string) : string {
    let data = this.getFileData(path);
    if (data != null && typeof data !== 'string')
      throw new Error(`${path}: expected string`)
    return data as string; // TODO
  }
  getFileEntry(path:string) : FileEntry {
    return this.workfs[path];
  }
}

var store = new FileWorkingStore();

///

class Builder {
  steps : BuildStep[] = [];
  startseq : number = 0;

  // returns true if file changed during this build step
  wasChanged(entry:FileEntry) : boolean {
    return entry.ts > this.startseq;
  }
  executeBuildSteps() {
    this.startseq = store.currentVersion();
    var linkstep : BuildStep = null;
    while (this.steps.length) {
      var step = this.steps.shift(); // get top of array
      var platform = step.platform;
      var toolfn = TOOLS[step.tool];
      if (!toolfn) throw Error("no tool named " + step.tool);
      step.params = PLATFORM_PARAMS[getBasePlatform(platform)];
      try {
        step.result = toolfn(step);
      } catch (e) {
        console.log("EXCEPTION", e, e.stack);
        return {errors:[{line:0, msg:e+""}]}; // TODO: catch errors already generated?
      }
      if (step.result) {
        step.result.params = step.params;
        // errors? return them
        if (step.result.errors && step.result.errors.length) {
          applyDefaultErrorPath(step.result.errors, step.path);
          return step.result;
        }
        // if we got some output, return it immediately
        if (step.result.output) {
          return step.result;
        }
        // combine files with a link tool?
        if (step.result.linktool) {
          if (linkstep) {
            linkstep.files = linkstep.files.concat(step.result.files);
            linkstep.args = linkstep.args.concat(step.result.args);
          } else {
            linkstep = {
              tool:step.result.linktool,
              platform:platform,
              files:step.result.files,
              args:step.result.args
            };
          }
        }
        // process with another tool?
        if (step.result.nexttool) {
          var asmstep : BuildStep = step.result;
          asmstep.tool = step.result.nexttool;
          asmstep.platform = platform;
          this.steps.push(asmstep);
        }
        // process final step?
        if (this.steps.length == 0 && linkstep) {
          this.steps.push(linkstep);
          linkstep = null;
        }
      }
    }
  }
  handleMessage(data: WorkerMessage) : WorkerResult {
    this.steps = [];
    // file updates
    if (data.updates) {
      for (var i=0; i<data.updates.length; i++) {
        var u = data.updates[i];
        store.putFile(u.path, u.data);
      }
    }
    // build steps
    if (data.buildsteps) {
      this.steps.push.apply(this.steps, data.buildsteps);
    }
    // single-file
    if (data.code) {
      this.steps.push(data);
    }
    // execute build steps
    if (this.steps.length) {
      var result = this.executeBuildSteps();
      return result ? result : {unchanged:true};
    }
    // TODO: cache results
    // message not recognized
    console.log("Unknown message",data);
  }
}

var builder = new Builder();

///

function applyDefaultErrorPath(errors:WorkerError[], path:string) {
  if (!path) return;
  for (var i=0; i<errors.length; i++) {
    var err = errors[i];
    if (!err.path && err.line) err.path = path;
  }
}

function compareData(a:FileData, b:FileData) : boolean {
  if (a.length != b.length) return false;
  if (typeof a === 'string' && typeof b === 'string') {
    return a == b;
  } else {
    for (var i=0; i<a.length; i++) {
      //if (a[i] != b[i]) console.log('differ at byte',i,a[i],b[i]);
      if (a[i] != b[i]) return false;
    }
    return true;
  }
}

function putWorkFile(path:string, data:FileData) {
  return store.putFile(path, data);
}

function getWorkFileAsString(path:string) : string {
  return store.getFileAsString(path);
}

function populateEntry(fs, path:string, entry:FileEntry, options:BuildOptions) {
  var data = entry.data;
  if (options && options.processFn) {
    data = options.processFn(path, data);
  }
  // create subfolders
  var toks = path.split('/');
  if (toks.length > 1) {
    for (var i=0; i<toks.length-1; i++)
      try {
        fs.mkdir(toks[i]);
      } catch (e) { }
  }
  // write file
  fs.writeFile(path, data, {encoding:entry.encoding});
  var time = new Date(entry.ts);
  fs.utime(path, time, time);
  console.log("<<<", path, entry.data.length);
}

// can call multiple times (from populateFiles)
function gatherFiles(step:BuildStep, options?:BuildOptions) : number {
  var maxts = 0;
  if (step.files) {
    for (var i=0; i<step.files.length; i++) {
      var path = step.files[i];
      var entry = store.workfs[path];
      if (!entry) {
        throw new Error("No entry for path '" + path + "'");
      } else {
        maxts = Math.max(maxts, entry.ts);
      }
    }
  }
  else if (step.code) {
    var path = step.path ? step.path : options.mainFilePath; // TODO: what if options null
    if (!path) throw Error("need path or mainFilePath");
    var code = step.code;
    var entry = putWorkFile(path, code);
    step.path = path;
    step.files = [path];
    maxts = entry.ts;
  }
  else if (step.path) {
    var path = step.path;
    var entry = store.workfs[path];
    maxts = entry.ts;
    step.files = [path];
  }
  if (step.path && !step.prefix) {
    step.prefix = getPrefix(step.path);
  }
  step.maxts = maxts;
  return maxts;
}

function getPrefix(s : string) : string {
  var pos = s.lastIndexOf('.');
  return (pos > 0) ? s.substring(0, pos) : s;
}

function populateFiles(step:BuildStep, fs, options?:BuildOptions) {
  gatherFiles(step, options);
  if (!step.files) throw Error("call gatherFiles() first");
  for (var i=0; i<step.files.length; i++) {
    var path = step.files[i];
    populateEntry(fs, path, store.workfs[path], options);
  }
}

function populateExtraFiles(step:BuildStep, fs, extrafiles) {
  if (extrafiles) {
    for (var i=0; i<extrafiles.length; i++) {
      var xfn = extrafiles[i];
      // is this file cached?
      if (store.workfs[xfn]) {
        fs.writeFile(xfn, store.workfs[xfn].data, {encoding:'binary'});
        continue;
      }
      // fetch from network
      var xpath = "lib/" + getBasePlatform(step.platform) + "/" + xfn;
      var xhr = new XMLHttpRequest();
      xhr.responseType = 'arraybuffer';
      xhr.open("GET", PWORKER+xpath, false);  // synchronous request
      xhr.send(null);
      if (xhr.response && xhr.status == 200) {
        var data = new Uint8Array(xhr.response);
        fs.writeFile(xfn, data, {encoding:'binary'});
        putWorkFile(xfn, data);
        console.log(":::",xfn,data.length);
      } else {
        throw Error("Could not load extra file " + xpath);
      }
    }
  }
}

function staleFiles(step:BuildStep, targets:string[]) {
  if (!step.maxts) throw Error("call populateFiles() first");
  // see if any target files are more recent than inputs
  for (var i=0; i<targets.length; i++) {
    var entry = store.workfs[targets[i]];
    if (!entry || step.maxts > entry.ts)
      return true;
  }
  console.log("unchanged", step.maxts, targets);
  return false;
}

function anyTargetChanged(step:BuildStep, targets:string[]) {
  if (!step.maxts) throw Error("call populateFiles() first");
  // see if any target files are more recent than inputs
  for (var i=0; i<targets.length; i++) {
    var entry = store.workfs[targets[i]];
    if (!entry || entry.ts > step.maxts)
      return true;
  }
  console.log("unchanged", step.maxts, targets);
  return false;
}

function execMain(step:BuildStep, mod, args:string[]) {
  starttime();
  var run = mod.callMain || mod.run; // TODO: run?
  run(args);
  endtime(step.tool);
}

/// asm.js / WASM / filesystem loading

var fsMeta = {};
var fsBlob = {};
var wasmBlob = {};

const PSRC = "../../src/";
const PWORKER = PSRC+"worker/";

// load filesystems for CC65 and others asynchronously
function loadFilesystem(name:string) {
  var xhr = new XMLHttpRequest();
  xhr.responseType = 'blob';
  xhr.open("GET", PWORKER+"fs/fs"+name+".data", false);  // synchronous request
  xhr.send(null);
  fsBlob[name] = xhr.response;
  xhr = new XMLHttpRequest();
  xhr.responseType = 'json';
  xhr.open("GET", PWORKER+"fs/fs"+name+".js.metadata", false);  // synchronous request
  xhr.send(null);
  fsMeta[name] = xhr.response;
  console.log("Loaded "+name+" filesystem", fsMeta[name].files.length, 'files', fsBlob[name].size, 'bytes');
}

var loaded = {};
function load(modulename:string, debug?:boolean) {
  if (!loaded[modulename]) {
    importScripts(PWORKER+'asmjs/'+modulename+(debug?"."+debug+".js":".js"));
    loaded[modulename] = 1;
  }
}
function loadWASM(modulename:string, debug?:boolean) {
  if (!loaded[modulename]) {
    importScripts(PWORKER+"wasm/" + modulename+(debug?"."+debug+".js":".js"));
    var xhr = new XMLHttpRequest();
    xhr.responseType = 'arraybuffer';
    xhr.open("GET", PWORKER+"wasm/"+modulename+".wasm", false);  // synchronous request
    xhr.send(null);
    if (xhr.response) {
      wasmBlob[modulename] = new Uint8Array(xhr.response);
      console.log("Loaded " + modulename + ".wasm (" + wasmBlob[modulename].length + " bytes)");
      loaded[modulename] = 1;
    } else {
      throw Error("Could not load WASM file " + modulename + ".wasm");
    }
  }
}
function loadNative(modulename:string) {
  // detect WASM
  if (CACHE_WASM_MODULES && typeof WebAssembly === 'object') {
    loadWASM(modulename);
  } else {
    load(modulename);
  }
}

// mount the filesystem at /share
function setupFS(FS, name:string) {
  var WORKERFS = FS.filesystems['WORKERFS'];
  if (name === '65-vector') name = '65-sim6502'; // TODO
  if (name === '65-atari7800') name = '65-sim6502'; // TODO
  if (name === '65-devel') name = '65-sim6502'; // TODO
  if (name === '65-vcs') name = '65-sim6502'; // TODO
  if (!fsMeta[name]) throw Error("No filesystem for '" + name + "'");
  FS.mkdir('/share');
  FS.mount(WORKERFS, {
    packages: [{ metadata: fsMeta[name], blob: fsBlob[name] }]
  }, '/share');
  // fix for slow Blob operations by caching typed arrays
  // https://github.com/kripken/emscripten/blob/incoming/src/library_workerfs.js
  // https://bugs.chromium.org/p/chromium/issues/detail?id=349304#c30
  var reader = WORKERFS.reader;
  var blobcache = {};
  WORKERFS.stream_ops.read = function (stream, buffer, offset, length, position) {
    if (position >= stream.node.size) return 0;
    var contents = blobcache[stream.path];
    if (!contents) {
      var ab = reader.readAsArrayBuffer(stream.node.contents);
      contents = blobcache[stream.path] = new Uint8Array(ab);
    }
    if (position + length > contents.length)
      length = contents.length - position;
    for (var i=0; i<length; i++) {
      buffer[offset+i] = contents[position+i];
    }
    return length;
  };
}

var print_fn = function(s:string) {
  console.log(s);
  //console.log(new Error().stack);
}

// test.c(6) : warning 85: in function main unreferenced local variable : 'x'
// main.a (4): error: Unknown Mnemonic 'xxx'.
// at 2: warning 190: ISO C forbids an empty source file
var re_msvc  = /[/]*([^( ]+)\s*[(](\d+)[)]\s*:\s*(.+?):\s*(.*)/;
var re_msvc2 = /\s*(at)\s+(\d+)\s*(:)\s*(.*)/;

function msvcErrorMatcher(errors:WorkerError[]) {
  return function(s:string) {
    var matches = re_msvc.exec(s) || re_msvc2.exec(s);
    if (matches) {
      var errline = parseInt(matches[2]);
      errors.push({
        line:errline,
        path:matches[1],
        //type:matches[3],
        msg:matches[4]
      });
    } else {
      console.log(s);
    }
  }
}

function makeErrorMatcher(errors:WorkerError[], regex, iline:number, imsg:number, mainpath:string, ifilename?:number) {
  return function(s) {
    var matches = regex.exec(s);
    if (matches) {
      errors.push({
        line:parseInt(matches[iline]) || 1,
        msg:matches[imsg],
        path:ifilename ? matches[ifilename] : mainpath
      });
    } else {
      console.log("??? "+s);
    }
  }
}

function extractErrors(regex, strings:string[], path:string, iline, imsg, ifilename) {
  var errors = [];
  var matcher = makeErrorMatcher(errors, regex, iline, imsg, path, ifilename);
  for (var i=0; i<strings.length; i++) {
    matcher(strings[i]);
  }
  return errors;
}

// TODO: "of" doesn't work in MSIE

var re_crlf = /\r?\n/;
//    1   %line 16+1 hello.asm
var re_lineoffset = /\s*(\d+)\s+[%]line\s+(\d+)\+(\d+)\s+(.+)/;

function parseListing(code:string, lineMatch, iline:number, ioffset:number, iinsns:number, icycles?:number) : SourceLine[] {
  var lines : SourceLine[] = [];
  var lineofs = 0;
  code.split(re_crlf).forEach((line, lineindex) => {
    var linem = lineMatch.exec(line);
    if (linem && linem[1]) {
      var linenum = iline < 0 ? lineindex : parseInt(linem[iline]);
      var offset = parseInt(linem[ioffset], 16);
      var insns = linem[iinsns];
      var cycles : number = icycles ? parseInt(linem[icycles]) : null;
      var iscode = cycles > 0;
      if (insns) {
        lines.push({
          line:linenum + lineofs,
          offset:offset,
          insns:insns,
          cycles:cycles,
          iscode:iscode
        });
      }
    } else {
      let m = re_lineoffset.exec(line);
      // TODO: check filename too
      if (m) {
        lineofs = parseInt(m[2]) - parseInt(m[1]) - parseInt(m[3]);
      }
    }
  });
  return lines;
}

function parseSourceLines(code:string, lineMatch, offsetMatch) {
  var lines = [];
  var lastlinenum = 0;
  for (var line of code.split(re_crlf)) {
    var linem = lineMatch.exec(line);
    if (linem && linem[1]) {
      lastlinenum = parseInt(linem[1]);
    } else if (lastlinenum) {
      var linem = offsetMatch.exec(line);
      if (linem && linem[1]) {
        var offset = parseInt(linem[1], 16);
        lines.push({
          line:lastlinenum,
          offset:offset,
        });
        lastlinenum = 0;
      }
    }
  }
  return lines;
}

function parseDASMListing(lstpath:string, lsttext:string, listings:CodeListingMap, errors:WorkerError[], unresolved:{}) {
  // TODO: this gets very slow
  // TODO: macros that are on adjacent lines don't get offset addresses
  //        4  08ee		       a9 00	   start      lda	#01workermain.js:23:5
  let lineMatch = /\s*(\d+)\s+(\S+)\s+([0-9a-f]+)\s+([?0-9a-f][?0-9a-f ]+)?\s+(.+)?/i;
  let equMatch = /\bequ\b/i;
  let macroMatch = /\bMAC\s+(\S+)?/i;
  let lastline = 0;
  let macros = {};
  let lstline = 0;
  let lstlist = listings[lstpath];
  for (let line of lsttext.split(re_crlf)) {
    lstline++;
    let linem = lineMatch.exec(line + "    ");
    if (linem && linem[1] != null) {
      let linenum = parseInt(linem[1]);
      let filename = linem[2];
      let offset = parseInt(linem[3], 16);
      let insns = linem[4];
      let restline = linem[5];
      if (insns && insns.startsWith('?')) insns = null;
      // don't use listing yet
      if (lstlist && lstlist.lines) {
        lstlist.lines.push({
          line:lstline,
          offset:offset,
          insns:insns,
          iscode:true,
        });
      }
      // inside of a file?
      let lst = listings[filename];
      if (lst) {
        var lines = lst.lines;
        // look for MAC statement
        let macmatch = macroMatch.exec(restline);
        if (macmatch) {
          macros[macmatch[1]] = {line:parseInt(linem[1]), file:linem[2].toLowerCase()};
        }
        else if (insns && restline && !restline.match(equMatch)) {
          lines.push({
            line:linenum,
            offset:offset,
            insns:insns,
            iscode:restline[0] != '.'
          });
        }
        lastline = linenum;
      } else {
        // inside of macro?
        let mac = macros[filename.toLowerCase()];
        // macro invocation in main file
        if (mac && linenum == 0) {
          lines.push({
            line:lastline+1,
            offset:offset,
            insns:insns,
            iscode:true
          });
        }
        if (insns && mac) {
          let maclst = listings[mac.file];
          if (maclst && maclst.lines) {
            maclst.lines.push({
              path:mac.file,
              line:mac.line+linenum,
              offset:offset,
              insns:insns,
              iscode:true
            });
          }
          // TODO: a listing file can't include other files
        } else {
          // inside of macro or include file
          if (insns && linem[3] && lastline>0) {
            lines.push({
              line:lastline+1,
              offset:offset,
              insns:null
            });
          }
        }
      }
      // TODO: better symbol test (word boundaries)
      // TODO: ignore IFCONST and IFNCONST usage
      for (let key in unresolved) {
        let l = restline || line;
        // find the identifier substring
        let pos = l.indexOf(key);
        if (pos >= 0) {
          // strip the comment, if any
          let cmt = l.indexOf(';');
          if (cmt < 0 || cmt > pos) {
            // make sure identifier is flanked by non-word chars
            if (new RegExp("\\b"+key+"\\b").exec(l)) {
              errors.push({
                path:filename,
                line:linenum,
                msg:"Unresolved symbol '" + key + "'"
              });
            }
          }
        }
      }
    }
    let errm = re_msvc.exec(line);
    if (errm) {
      errors.push({
        path:errm[1],
        line:parseInt(errm[2]),
        msg:errm[4]
      })
    }
  }
}

function assembleDASM(step:BuildStep) {
  load("dasm");
  var re_usl = /(\w+)\s+0000\s+[?][?][?][?]/;
  var unresolved = {};
  var errors = [];
  var errorMatcher = msvcErrorMatcher(errors);
  function match_fn(s:string) {
    // TODO: what if s is not string? (startsWith is not a function)
    var matches = re_usl.exec(s);
    if (matches) {
      var key = matches[1];
      if (key != 'NO_ILLEGAL_OPCODES') { // TODO
        unresolved[matches[1]] = 0;
      }
    } else if (s.startsWith("Warning:")) {
      errors.push({line:0, msg:s.substr(9)});
    } else if (s.startsWith("unable ")) {
      errors.push({line:0, msg:s});
    } else if (s.startsWith("segment: ")) {
      errors.push({line:0, msg:"Segment overflow: "+s.substring(9)});
    } else if (s.toLowerCase().indexOf('error:') >= 0) {
      errors.push({line:0, msg:s.trim()});
    } else {
      errorMatcher(s);
    }
  }
  var Module : EmscriptenModule = emglobal.DASM({
    noInitialRun:true,
    print:match_fn
  });
  var FS = Module.FS;
  populateFiles(step, FS, {
    mainFilePath:'main.a'
  });
  var binpath = step.prefix+'.bin';
  var lstpath = step.prefix+'.lst';
  var sympath = step.prefix+'.sym';
  execMain(step, Module, [step.path, '-f3',
    "-l"+lstpath,
    "-o"+binpath,
    "-s"+sympath ]);
  var alst = FS.readFile(lstpath, {'encoding':'utf8'});
  // parse main listing, get errors and listings for each file
  var listings : CodeListingMap = {};
  //listings[lstpath] = {lines:[], text:alst};
  for (let path of step.files) {
    listings[path] = {lines:[]};
  }
  parseDASMListing(lstpath, alst, listings, errors, unresolved);
  if (errors.length) {
    return {errors:errors};
  }
  // read binary rom output and symbols
  var aout, asym;
  aout = FS.readFile(binpath);
  try {
    asym = FS.readFile(sympath, {'encoding':'utf8'});
  } catch (e) {
    console.log(e);
    errors.push({line:0,msg:"No symbol table generated, maybe segment overflow?"});
    return {errors:errors}
  }
  putWorkFile(binpath, aout);
  putWorkFile(lstpath, alst);
  putWorkFile(sympath, asym);
  // return unchanged if no files changed
  // TODO: what if listing or symbols change?
  if (!anyTargetChanged(step, [binpath/*, lstpath, sympath*/]))
    return;
  var symbolmap = {};
  for (var s of asym.split("\n")) {
    var toks = s.split(/\s+/);
    if (toks && toks.length >= 2 && !toks[0].startsWith('-')) {
      symbolmap[toks[0]] = parseInt(toks[1], 16);
    }
  }
  // for bataribasic (TODO)
  if (step['bblines']) {
    let lst = listings[step.path];
    if (lst) {
      lst.asmlines = lst.lines;
      lst.text = alst;
      lst.lines = [];
    }
  }
  return {
    output:aout,
    listings:listings,
    errors:errors,
    symbolmap:symbolmap,
  };
}

function setupStdin(fs, code:string) {
  var i = 0;
  fs.init(
    function() { return i<code.length ? code.charCodeAt(i++) : null; }
  );
}

//TODO: this doesn't align very well
    /*
000000r 1               .segment        "CODE"
000000r 1               .proc	_rasterWait: near
000000r 1               ; int main() { return mul2(2); }
000000r 1                       .dbg    line, "main.c", 3
000014r 1                      	.dbg	  func, "main", "00", extern, "_main"
000000r 1  A2 00                ldx     #$00
00B700  1               BOOT2:
00B700  1  A2 01         ldx #1 ;track
00B725  1  00           IBLASTDRVN: .byte 0
00B726  1  xx xx        IBSECSZ: .res 2
00BA2F  1  2A 2B E8 2C   HEX "2A2BE82C2D2E2F303132F0F133343536"
    */
function parseCA65Listing(code, symbols, params, dbg) {
  var segofs = 0;
  var offset = 0;
  var dbgLineMatch = /^([0-9A-F]+)([r]?)\s+(\d+)\s+[.]dbg\s+(\w+), "([^"]+)", (.+)/;
  var funcLineMatch = /"(\w+)", (\w+), "(\w+)"/;
  var insnLineMatch = /^([0-9A-F]+)([r]?)\s{1,2}(\d+)\s{1,2}([0-9A-Frx ]{11})\s+(.*)/;
  var segMatch = /[.]segment\s+"(\w+)"/i;
  var lines = [];
  var linenum = 0;
  // TODO: only does .c functions, not all .s files
  for (var line of code.split(re_crlf)) {
    var dbgm = dbgLineMatch.exec(line);
    if (dbgm && dbgm[1]) {
      var dbgtype = dbgm[4];
      offset = parseInt(dbgm[1], 16);
      if (dbgtype == 'func') {
        var funcm = funcLineMatch.exec(dbgm[6]);
        if (funcm) {
          var funcofs = symbols[funcm[3]];
          if (typeof funcofs === 'number') {
            segofs = funcofs - offset;
            //console.log(funcm[3], funcofs, '-', offset);
          }
        }
      }
    }
    if (dbg) {
      if (dbgm && dbgtype == 'line') {
        lines.push({
          // TODO: sourcefile
          line:parseInt(dbgm[6]),
          offset:offset + segofs,
          insns:null
        });
      }
    } else {
      var linem = insnLineMatch.exec(line);
      var topfile = linem && linem[3] == '1';
      if (topfile) linenum++;
      if (topfile && linem[1]) {
        var offset = parseInt(linem[1], 16);
        var insns = linem[4].trim();
        if (insns.length) {
          // take back one to honor the long .byte line
          if (linem[5].length == 0) {
            linenum--;
          } else {
            lines.push({
              line:linenum,
              offset:offset + segofs,
              insns:insns,
              iscode:true // TODO: can't really tell unless we parse it
            });
          }
        } else {
          var sym = linem[5];
          var segm = sym && segMatch.exec(sym);
          if (segm && segm[1]) {
            var symofs = symbols['__' + segm[1] + '_RUN__'];
            if (typeof symofs === 'number') {
              segofs = symofs;
              //console.log(sym, symofs, '-', offset);
            }
          } else if (sym.endsWith(':') && !sym.startsWith('@')) {
            var symofs = symbols[sym.substring(0,sym.length-1)];
            if (typeof symofs === 'number') {
              segofs = symofs - offset;
              //console.log(sym, segofs, symofs, offset);
            }
          }
        }
      }
    }
  }
  return lines;
}

function assembleCA65(step:BuildStep) {
  loadNative("ca65");
  var errors = [];
  gatherFiles(step, {mainFilePath:"main.s"});
  var objpath = step.prefix+".o";
  var lstpath = step.prefix+".lst";
  if (staleFiles(step, [objpath, lstpath])) {
    var objout, lstout;
    var CA65 : EmscriptenModule = emglobal.ca65({
      instantiateWasm: moduleInstFn('ca65'),
      noInitialRun:true,
      //logReadFiles:true,
      print:print_fn,
      printErr:msvcErrorMatcher(errors),
    });
    var FS = CA65.FS;
    setupFS(FS, '65-'+getRootBasePlatform(step.platform));
    populateFiles(step, FS);
    fixParamsWithDefines(step.path, step.params);
    var args = ['-v', '-g', '-I', '/share/asminc', '-o', objpath, '-l', lstpath, step.path];
    args.unshift.apply(args, ["-D", "__8BITWORKSHOP__=1"]);
    if (step.mainfile) {
      args.unshift.apply(args, ["-D", "__MAIN__=1"]);
    }
    execMain(step, CA65, args);
    if (errors.length)
      return {errors:errors};
    objout = FS.readFile(objpath, {encoding:'binary'});
    lstout = FS.readFile(lstpath, {encoding:'utf8'});
    putWorkFile(objpath, objout);
    putWorkFile(lstpath, lstout);
  }
  return {
    linktool:"ld65",
    files:[objpath, lstpath],
    args:[objpath]
  };
}

function linkLD65(step:BuildStep) {
  loadNative("ld65");
  var params = step.params;
  gatherFiles(step);
  var binpath = "main";
  if (staleFiles(step, [binpath])) {
    var errors = [];
    var LD65 : EmscriptenModule = emglobal.ld65({
      instantiateWasm: moduleInstFn('ld65'),
      noInitialRun:true,
      //logReadFiles:true,
      print:print_fn,
      printErr:function(s) { errors.push({msg:s,line:0}); }
    });
    var FS = LD65.FS;
    setupFS(FS, '65-'+getRootBasePlatform(step.platform));
    populateFiles(step, FS);
    populateExtraFiles(step, FS, params.extra_link_files);
    // populate .cfg file, if it is a custom one
    if (store.hasFile(params.cfgfile)) {
      populateEntry(FS, params.cfgfile, store.getFileEntry(params.cfgfile), null);
    }
    var libargs = params.libargs || [];
    var cfgfile = params.cfgfile;
    var args = ['--cfg-path', '/share/cfg',
      '--lib-path', '/share/lib',
      '-C', cfgfile,
      '-Ln', 'main.vice',
      //'--dbgfile', 'main.dbg', // TODO: get proper line numbers
      '-o', 'main', '-m', 'main.map'].concat(step.args, libargs);
    //console.log(args);
    execMain(step, LD65, args);
    if (errors.length)
      return {errors:errors};
    var aout = FS.readFile("main", {encoding:'binary'});
    var mapout = FS.readFile("main.map", {encoding:'utf8'});
    var viceout = FS.readFile("main.vice", {encoding:'utf8'});
    //var dbgout = FS.readFile("main.dbg", {encoding:'utf8'});
    putWorkFile("main", aout);
    putWorkFile("main.map", mapout);
    putWorkFile("main.vice", viceout);
    // return unchanged if no files changed
    if (!anyTargetChanged(step, ["main", "main.map", "main.vice"]))
      return;
    // parse symbol map (TODO: omit segments, constants)
    var symbolmap = {};
    for (var s of viceout.split("\n")) {
      var toks = s.split(" ");
      if (toks[0] == 'al') {
        let ident = toks[2].substr(1);
        if (ident.length != 5 || !ident.startsWith('L')) { // no line numbers
          let ofs = parseInt(toks[1], 16);
          symbolmap[ident] = ofs;
        }
      }
    }
    // build segment map
    var seg_re = /^__(\w+)_SIZE__$/;
    // TODO: move to Platform class
    var segments = [];
    segments.push({name:'CPU Stack',start:0x100,size:0x100,type:'ram'});
    segments.push({name:'CPU Vectors',start:0xfffa,size:0x6,type:'rom'});
    // TODO: CHR, banks, etc
    for (let ident in symbolmap) {
      let m = seg_re.exec(ident);
      if (m) {
        let seg = m[1];
        let segstart = symbolmap['__'+seg+'_RUN__'] || symbolmap['__'+seg+'_START__'];
        let segsize = symbolmap['__'+seg+'_SIZE__'];
        let seglast = symbolmap['__'+seg+'_LAST__'];
        if (segstart >= 0 && segsize > 0 && !seg.startsWith('PRG') && seg != 'RAM') { // TODO
          var type = null;
          if (seg.startsWith('CODE') || seg == 'STARTUP' || seg == 'RODATA' || seg.endsWith('ROM')) type = 'rom';
          else if (seg == 'ZP' || seg == 'DATA' || seg == 'BSS' || seg.endsWith('RAM')) type = 'ram';
          segments.push({name:seg, start:segstart, size:segsize, last:seglast, type:type});
        }
      }
    }
    // build listings
    var listings : CodeListingMap = {};
    for (var fn of step.files) {
      if (fn.endsWith('.lst')) {
        var lstout = FS.readFile(fn, {encoding:'utf8'});
        lstout = lstout.split('\n\n')[1] || lstout; // remove header
        var asmlines = parseCA65Listing(lstout, symbolmap, params, false);
        var srclines = parseCA65Listing(lstout, symbolmap, params, true);
        putWorkFile(fn, lstout);
        // TODO: you have to get rid of all source lines to get asm listing
        listings[fn] = {
          asmlines:srclines.length ? asmlines : null,
          lines:srclines.length ? srclines : asmlines,
          text:lstout
        };
      }
    }
    return {
      output:aout, //.slice(0),
      listings:listings,
      errors:errors,
      symbolmap:symbolmap,
      segments:segments
    };
  }
}

function fixParamsWithDefines(path:string, params){
  var libargs = params.libargs;
  if (path && libargs) {
    var code = getWorkFileAsString(path);
    if (code) {
      var oldcfgfile = params.cfgfile;
      var ident2index = {};
      // find all lib args "IDENT=VALUE"
      for (var i=0; i<libargs.length; i++) {
        var toks = libargs[i].split('=');
        if (toks.length == 2) {
          ident2index[toks[0]] = i;
        }
      }
      // find #defines and replace them
      var re = /^[;]?#define\s+(\w+)\s+(\S+)/gmi; // TODO: empty string?
      var m;
      while (m = re.exec(code)) {
        var ident = m[1];
        var value = m[2];
        var index = ident2index[ident];
        if (index >= 0) {
          libargs[index] = ident + "=" + value;
          console.log('Using libargs', index, libargs[index]);
          // TODO: MMC3 mapper switch
          if (ident == 'NES_MAPPER' && value == '4') {
            params.cfgfile = 'nesbanked.cfg';
            console.log("using config file", params.cfgfile);
          }
        } else if (ident == 'CFGFILE' && value) {
          params.cfgfile = value;
        } else if (ident == 'LIBARGS' && value) {
          params.libargs = value.split(',').filter((s) => { return s!=''; });
          console.log('Using libargs', params.libargs);
        } else if (ident == 'CC65_FLAGS' && value) {
          params.extra_compiler_args = value.split(',').filter((s) => { return s!=''; });
          console.log('Using compiler flags', params.extra_compiler_args);
        }
      }
    }
  }
}

function compileCC65(step:BuildStep) {
  loadNative("cc65");
  var params = step.params;
  // stderr
  var re_err1 = /(.*?)[(](\d+)[)].*?: (.+)/;
  var errors : WorkerError[] = [];
  var errline = 0;
  function match_fn(s) {
    console.log(s);
    var matches = re_err1.exec(s);
    if (matches) {
      errline = parseInt(matches[2]);
      errors.push({
        line:errline,
        msg:matches[3],
        path:matches[1]
      });
    }
  }
  gatherFiles(step, {mainFilePath:"main.c"});
  var destpath = step.prefix + '.s';
  if (staleFiles(step, [destpath])) {
    var CC65 : EmscriptenModule = emglobal.cc65({
      instantiateWasm: moduleInstFn('cc65'),
      noInitialRun:true,
      //logReadFiles:true,
      print:print_fn,
      printErr:match_fn,
    });
    var FS = CC65.FS;
    setupFS(FS, '65-'+getRootBasePlatform(step.platform));
    populateFiles(step, FS);
    fixParamsWithDefines(step.path, params);
    var args = [
      '-I', '/share/include',
      '-I', '.',
      "-D", "__8BITWORKSHOP__",
    ];
    if (params.define) {
      params.define.forEach((x) => args.push('-D'+x));
    }
    if (step.mainfile) {
      args.unshift.apply(args, ["-D", "__MAIN__"]);
    }
    var customArgs = params.extra_compiler_args || ['-T', '-g', '-Oirs', '-Cl'];
    args = args.concat(customArgs, args);
    args.push(step.path);
    //console.log(args);
    execMain(step, CC65, args);
    if (errors.length)
      return {errors:errors};
    var asmout = FS.readFile(destpath, {encoding:'utf8'});
    putWorkFile(destpath, asmout);
  }
  return {
    nexttool:"ca65",
    path:destpath,
    args:[destpath],
    files:[destpath],
  };
}

function hexToArray(s, ofs) {
  var buf = new ArrayBuffer(s.length/2);
  var arr = new Uint8Array(buf);
  for (var i=0; i<arr.length; i++) {
    arr[i] = parseInt(s.slice(i*2+ofs,i*2+ofs+2), 16);
  }
  return arr;
}

function parseIHX(ihx, rom_start, rom_size, errors) {
  var output = new Uint8Array(new ArrayBuffer(rom_size));
  var high_size = 0;
  for (var s of ihx.split("\n")) {
    if (s[0] == ':') {
      var arr = hexToArray(s, 1);
      var count = arr[0];
      var address = (arr[1]<<8) + arr[2] - rom_start;
      var rectype = arr[3];
      //console.log(rectype,address.toString(16),count,arr);
      if (rectype == 0) {
        for (var i=0; i<count; i++) {
          var b = arr[4+i];
          output[i+address] = b;
        }
        if (i+address > high_size) high_size = i+address;
      } else if (rectype == 1) {
        break;
      } else {
        console.log(s); // unknown record type
      }
    }
  }
  // TODO: return ROM anyway?
  if (high_size > rom_size) {
    //errors.push({line:0, msg:"ROM size too large: 0x" + high_size.toString(16) + " > 0x" + rom_size.toString(16)});
  }
  return output;
}

function assembleSDASZ80(step:BuildStep) {
  loadNative("sdasz80");
  var objout, lstout, symout;
  var errors = [];
  gatherFiles(step, {mainFilePath:"main.asm"});
  var objpath = step.prefix + ".rel";
  var lstpath = step.prefix + ".lst";
  if (staleFiles(step, [objpath, lstpath])) {
    //?ASxxxx-Error-<o> in line 1 of main.asm null
    //              <o> .org in REL area or directive / mnemonic error
    // ?ASxxxx-Error-<q> in line 1627 of cosmic.asm
    //    <q> missing or improper operators, terminators, or delimiters
    var match_asm_re1 = / in line (\d+) of (\S+)/; // TODO
    var match_asm_re2 = / <\w> (.+)/; // TODO
    var errline = 0;
    var errpath = step.path;
    var match_asm_fn = (s:string) => {
      var m = match_asm_re1.exec(s);
      if (m) {
        errline = parseInt(m[1]);
        errpath = m[2];
      } else {
        m = match_asm_re2.exec(s);
        if (m) {
          errors.push({
            line:errline,
            path:errpath,
            msg:m[1]
          });
        }
      }
    }
    var ASZ80 : EmscriptenModule = emglobal.sdasz80({
      instantiateWasm: moduleInstFn('sdasz80'),
      noInitialRun:true,
      //logReadFiles:true,
      print:match_asm_fn,
      printErr:match_asm_fn,
    });
    var FS = ASZ80.FS;
    populateFiles(step, FS);
    execMain(step, ASZ80, ['-plosgffwy', step.path]);
    if (errors.length) {
      return {errors:errors};
    }
    objout = FS.readFile(objpath, {encoding:'utf8'});
    lstout = FS.readFile(lstpath, {encoding:'utf8'});
    putWorkFile(objpath, objout);
    putWorkFile(lstpath, lstout);
  }
  return {
    linktool:"sdldz80",
    files:[objpath, lstpath],
    args:[objpath]
  };
  //symout = FS.readFile("main.sym", {encoding:'utf8'});
}

function linkSDLDZ80(step:BuildStep)
{
  loadNative("sdldz80");
  var errors = [];
  gatherFiles(step);
  var binpath = "main.ihx";
  if (staleFiles(step, [binpath])) {
    //?ASlink-Warning-Undefined Global '__divsint' referenced by module 'main'
    var match_aslink_re = /\?ASlink-(\w+)-(.+)/;
    var match_aslink_fn = (s:string) => {
      var matches = match_aslink_re.exec(s);
      if (matches) {
        errors.push({
          line:0,
          msg:matches[2]
        });
      }
    }
    var params = step.params;
    var LDZ80 : EmscriptenModule = emglobal.sdldz80({
      instantiateWasm: moduleInstFn('sdldz80'),
      noInitialRun:true,
      //logReadFiles:true,
      print:match_aslink_fn,
      printErr:match_aslink_fn,
    });
    var FS = LDZ80.FS;
    setupFS(FS, 'sdcc');
    populateFiles(step, FS);
    populateExtraFiles(step, FS, params.extra_link_files);
    // TODO: coleco hack so that -u flag works
    if (step.platform.startsWith("coleco")) {
      FS.writeFile('crt0.rel', FS.readFile('/share/lib/coleco/crt0.rel', {encoding:'utf8'}));
      FS.writeFile('crt0.lst', '\n'); // TODO: needed so -u flag works
    }
    var args = ['-mjwxyu',
      '-i', 'main.ihx', // TODO: main?
      '-b', '_CODE=0x'+params.code_start.toString(16),
      '-b', '_DATA=0x'+params.data_start.toString(16),
      '-k', '/share/lib/z80',
      '-l', 'z80'];
    if (params.extra_link_args)
      args.push.apply(args, params.extra_link_args);
    args.push.apply(args, step.args);
    //console.log(args);
    execMain(step, LDZ80, args);
    var hexout = FS.readFile("main.ihx", {encoding:'utf8'});
    var noiout = FS.readFile("main.noi", {encoding:'utf8'});
    putWorkFile("main.ihx", hexout);
    putWorkFile("main.noi", noiout);
    // return unchanged if no files changed
    if (!anyTargetChanged(step, ["main.ihx", "main.noi"]))
      return;
    // parse binary file
    var binout = parseIHX(hexout, params.rom_start!==undefined?params.rom_start:params.code_start, params.rom_size, errors);
    if (errors.length) {
      return {errors:errors};
    }
    // parse listings
    var listings : CodeListingMap = {};
    for (var fn of step.files) {
      if (fn.endsWith('.lst')) {
        var rstout = FS.readFile(fn.replace('.lst','.rst'), {encoding:'utf8'});
        //   0000 21 02 00      [10]   52 	ld	hl, #2
        var asmlines = parseListing(rstout, /^\s*([0-9A-F]{4})\s+([0-9A-F][0-9A-F r]*[0-9A-F])\s+\[([0-9 ]+)\]?\s+(\d+) (.*)/i, 4, 1, 2, 3);
        var srclines = parseSourceLines(rstout, /^\s+\d+ ;<stdin>:(\d+):/i, /^\s*([0-9A-F]{4})/i);
        putWorkFile(fn, rstout);
        // TODO: you have to get rid of all source lines to get asm listing
        listings[fn] = {
          asmlines:srclines.length ? asmlines : null,
          lines:srclines.length ? srclines : asmlines,
          text:rstout
        };
      }
    }
    // parse symbol map
    var symbolmap = {};
    for (var s of noiout.split("\n")) {
      var toks = s.split(" ");
      if (toks[0] == 'DEF' && !toks[1].startsWith("A$")) {
        symbolmap[toks[1]] = parseInt(toks[2], 16);
      }
    }
    // build segment map
    var seg_re = /^s__(\w+)$/;
    var segments = [];
    // TODO: use stack params for stack segment
    for (let ident in symbolmap) {
      let m = seg_re.exec(ident);
      if (m) {
        let seg = m[1];
        let segstart = symbolmap[ident]; // s__SEG
        let segsize = symbolmap['l__'+seg]; // l__SEG
        if (segstart >= 0 && segsize > 0) {
          var type = null;
          if (['INITIALIZER','GSINIT','GSFINAL'].includes(seg)) type = 'rom';
          else if (seg.startsWith('CODE')) type = 'rom';
          else if (['DATA','INITIALIZED'].includes(seg)) type = 'ram';
          if (type == 'rom' || segstart > 0) // ignore HEADER0, CABS0, etc (TODO?)
            segments.push({name:seg, start:segstart, size:segsize, type:type});
        }
      }
    }
    return {
      output:binout,
      listings:listings,
      errors:errors,
      symbolmap:symbolmap,
      segments:segments
    };
  }
}

function compileSDCC(step:BuildStep) {

  gatherFiles(step, {
    mainFilePath:"main.c" // not used
  });
  var outpath = step.prefix + ".asm";
  if (staleFiles(step, [outpath])) {
    var errors = [];
    var params = step.params;
    loadNative('sdcc');
    var SDCC : EmscriptenModule = emglobal.sdcc({
      instantiateWasm: moduleInstFn('sdcc'),
      noInitialRun:true,
      noFSInit:true,
      print:print_fn,
      printErr:msvcErrorMatcher(errors),
      //TOTAL_MEMORY:256*1024*1024,
    });
    var FS = SDCC.FS;
    populateFiles(step, FS);
    // load source file and preprocess
    var code = getWorkFileAsString(step.path);
    var preproc = preprocessMCPP(step, 'sdcc');
    if (preproc.errors) return preproc;
    else code = preproc.code;
    // pipe file to stdin
    setupStdin(FS, code);
    setupFS(FS, 'sdcc');
    var args = ['--vc', '--std-sdcc99', '-mz80', //'-Wall',
      '--c1mode',
      //'--debug',
      //'-S', 'main.c',
      //'--asm=sdasz80',
      //'--reserve-regs-iy',
      '--less-pedantic',
      ///'--fomit-frame-pointer',
      //'--opt-code-speed',
      //'--max-allocs-per-node', '1000',
      //'--cyclomatic',
      //'--nooverlay',
      //'--nogcse',
      //'--nolabelopt',
      //'--noinvariant',
      //'--noinduction',
      //'--nojtbound',
      //'--noloopreverse',
      '-o', outpath];
    // if "#pragma opt_code" found do not disable optimziations
    if (!/^\s*#pragma\s+opt_code/m.exec(code)) {
      args.push.apply(args, [
        '--oldralloc',
        '--no-peep',
        '--nolospre'
      ]);
    }
    if (params.extra_compile_args) {
      args.push.apply(args, params.extra_compile_args);
    }
    execMain(step, SDCC, args);
    // TODO: preprocessor errors w/ correct file
    if (errors.length /* && nwarnings < msvc_errors.length*/) {
      return {errors:errors};
    }
    // massage the asm output
    var asmout = FS.readFile(outpath, {encoding:'utf8'});
    asmout = " .area _HOME\n .area _CODE\n .area _INITIALIZER\n .area _DATA\n .area _INITIALIZED\n .area _BSEG\n .area _BSS\n .area _HEAP\n" + asmout;
    putWorkFile(outpath, asmout);
  }
  return {
    nexttool:"sdasz80",
    path:outpath,
    args:[outpath],
    files:[outpath],
  };
}

function makeCPPSafe(s:string) : string {
  return s.replace(/[^A-Za-z0-9_]/g,'_');
}

function preprocessMCPP(step:BuildStep, filesys:string) {
  load("mcpp");
  var platform = step.platform;
  var params = PLATFORM_PARAMS[getBasePlatform(platform)];
  if (!params) throw Error("Platform not supported: " + platform);
  // <stdin>:2: error: Can't open include file "foo.h"
  var errors = [];
  var match_fn = makeErrorMatcher(errors, /<stdin>:(\d+): (.+)/, 1, 2, step.path);
  var MCPP : EmscriptenModule = emglobal.mcpp({
    noInitialRun:true,
    noFSInit:true,
    print:print_fn,
    printErr:match_fn,
  });
  var FS = MCPP.FS;
  if (filesys) setupFS(FS, filesys);
  populateFiles(step, FS);
  populateExtraFiles(step, FS, params.extra_compile_files);
  // TODO: make configurable by other compilers
  var args = [
    "-D", "__8BITWORKSHOP__",
    "-D", "__SDCC_z80",
    "-D", makeCPPSafe(platform.toUpperCase()),
    "-I", "/share/include",
    "-Q",
    step.path, "main.i"];
  if (step.mainfile) {
    args.unshift.apply(args, ["-D", "__MAIN__"]);
  }
  if (params.extra_preproc_args) {
    args.push.apply(args, params.extra_preproc_args);
  }
  execMain(step, MCPP, args);
  if (errors.length)
    return {errors:errors};
  var iout = FS.readFile("main.i", {encoding:'utf8'});
  iout = iout.replace(/^#line /gm,'\n# ');
  try {
    var errout = FS.readFile("mcpp.err", {encoding:'utf8'});
    if (errout.length) {
      // //main.c:2: error: Can't open include file "stdiosd.h"
      var errors = extractErrors(/([^:]+):(\d+): (.+)/, errout.split("\n"), step.path, 2, 3, 1);
      if (errors.length == 0) {
        errors = [{line:0, msg:errout}];
      }
      return {errors: errors};
    }
  } catch (e) {
    //
  }
  return {code:iout};
}

// TODO: must be a better way to do all this

function detectModuleName(code:string) {
  var m = /^\s*module\s+(\w+_top)\b/m.exec(code)
       || /^\s*module\s+(top|t)\b/m.exec(code)
       || /^\s*module\s+(\w+)\b/m.exec(code);
  return m ? m[1] : null;
}

function detectTopModuleName(code:string) {
  var topmod = detectModuleName(code) || "top";
  var m = /^\s*module\s+(\w+?_top)/m.exec(code);
  if (m && m[1]) topmod = m[1];
  return topmod;
}

// cached stuff (TODO)
var jsasm_module_top;
var jsasm_module_output;
var jsasm_module_key;

function compileJSASM(asmcode:string, platform, options, is_inline) {
  var asm = new Assembler(null);
  var includes = [];
  asm.loadJSON = (filename:string) => {
    var jsontext = getWorkFileAsString(filename);
    if (!jsontext) throw Error("could not load " + filename);
    return JSON.parse(jsontext);
  };
  asm.loadInclude = (filename) => {
    if (!filename.startsWith('"') || !filename.endsWith('"'))
      return 'Expected filename in "double quotes"';
    filename = filename.substr(1, filename.length-2);
    includes.push(filename);
  };
  var loaded_module = false;
  asm.loadModule = (top_module : string) => {
    // compile last file in list
    loaded_module = true;
    var key = top_module + '/' + includes;
    if (jsasm_module_key != key) {
      jsasm_module_key = key;
      jsasm_module_output = null;
    }
    jsasm_module_top = top_module;
    var main_filename = includes[includes.length-1];
    // TODO: take out .asm dependency
    var voutput = compileVerilator({platform:platform, files:includes, path:main_filename, tool:'verilator'});
    if (voutput)
      jsasm_module_output = voutput;
    return null; // no error
  }
  var result = asm.assembleFile(asmcode);
  if (loaded_module && jsasm_module_output) {
    // errors? return them
    if (jsasm_module_output.errors && jsasm_module_output.errors.length)
      return jsasm_module_output;
    // return program ROM array
    var asmout = result.output;
    // TODO: unify
    result.output = jsasm_module_output.output;
    // TODO: typecheck this garbage
    (result as any).output.program_rom = asmout;
    // TODO: not cpu_platform__DOT__program_rom anymore, make const
    (result as any).output.program_rom_variable = jsasm_module_top + "$program_rom";
    (result as any).listings = {};
    (result as any).listings[options.path] = {lines:result.lines};
    return result;
  } else {
    return result;
  }
}

function compileJSASMStep(step:BuildStep) {
  gatherFiles(step);
  var code = getWorkFileAsString(step.path);
  var platform = step.platform || 'verilog';
  return compileJSASM(code, platform, step, false);
}

function compileInlineASM(code:string, platform, options, errors, asmlines) {
  code = code.replace(/__asm\b([\s\S]+?)\b__endasm\b/g, function(s,asmcode,index) {
    var firstline = code.substr(0,index).match(/\n/g).length;
    var asmout = compileJSASM(asmcode, platform, options, true);
    if (asmout.errors && asmout.errors.length) {
      for (var i=0; i<asmout.errors.length; i++) {
        asmout.errors[i].line += firstline;
        errors.push(asmout.errors[i]);
      }
      return "";
    } else if (asmout.output) {
      let s = "";
      var out = asmout.output;
      for (var i=0; i<out.length; i++) {
        if (i>0) {
          s += ",";
          if ((i & 0xff) == 0) s += "\n";
        }
        s += 0|out[i];
      }
      if (asmlines) {
        var al = asmout.lines;
        for (var i=0; i<al.length; i++) {
          al[i].line += firstline;
          asmlines.push(al[i]);
        }
      }
      return s;
    }
  });
  return code;
}

import * as hdltypes from '../common/hdl/hdltypes';
import * as vxmlparser from '../common/hdl/vxmlparser';

function compileVerilator(step:BuildStep) {
  loadNative("verilator_bin");
  var platform = step.platform || 'verilog';
  var errors : WorkerError[] = [];
  gatherFiles(step);
  // compile verilog if files are stale
  if (staleFiles(step, [xmlPath])) {
    // TODO: %Error: Specified --top-module 'ALU' isn't at the top level, it's under another cell 'cpu'
    // TODO: ... Use "/* verilator lint_off BLKSEQ */" and lint_on around source to disable this message.
    var match_fn = makeErrorMatcher(errors, /%(.+?): (.+?):(\d+)?[:]?\s*(.+)/i, 3, 4, step.path, 2);
    var verilator_mod : EmscriptenModule = emglobal.verilator_bin({
      instantiateWasm: moduleInstFn('verilator_bin'),
      noInitialRun: true,
      noExitRuntime: true,
      print: print_fn,
      printErr: match_fn,
      wasmMemory: getWASMMemory(), // reuse memory
      //INITIAL_MEMORY:256*1024*1024,
    });
    var code = getWorkFileAsString(step.path);
    var topmod = detectTopModuleName(code);
    var FS = verilator_mod.FS;
    var listings : CodeListingMap = {};
    // process inline assembly, add listings where found
    populateFiles(step, FS, {
      mainFilePath:step.path,
      processFn:(path,code) => {
        if (typeof code === 'string') {
          let asmlines = [];
          code = compileInlineASM(code, platform, step, errors, asmlines);
          if (asmlines.length) {
            listings[path] = {lines:asmlines};
          }
        }
        return code;
      }
    });
    starttime();
    var xmlPath = `obj_dir/V${topmod}.xml`;
    try {
      var args = ["--cc", "-O3",
        "-DEXT_INLINE_ASM", "-DTOPMOD__"+topmod, "-D__8BITWORKSHOP__",
        "-Wall",
        "-Wno-DECLFILENAME", "-Wno-UNUSED", "-Wno-EOFNEWLINE", "-Wno-PROCASSWIRE",
        "--x-assign", "fast", "--noassert", "--pins-sc-biguint",
        "--debug-check", // for XML output
        "--top-module", topmod, step.path]
      execMain(step, verilator_mod, args);
    } catch (e) {
      console.log(e);
      errors.push({line:0,msg:"Compiler internal error: " + e});
    }
    endtime("compile");
    // remove boring errors
    errors = errors.filter(function(e) { return !/Exiting due to \d+/.exec(e.msg); }, errors);
    errors = errors.filter(function(e) { return !/Use ["][/][*]/.exec(e.msg); }, errors);
    if (errors.length) {
      return {errors:errors};
    }
    starttime();
    var xmlParser = new vxmlparser.VerilogXMLParser();
    try {
      var xmlContent = FS.readFile(xmlPath, {encoding:'utf8'});
      var xmlScrubbed = xmlContent.replace(/ fl=".+?" loc=".+?"/g, '');
      // TODO: this squelches the .asm listing
      //listings[step.prefix + '.xml'] = {lines:[],text:xmlContent};
      putWorkFile(xmlPath, xmlScrubbed); // don't detect changes in source position
      if (!anyTargetChanged(step, [xmlPath]))
        return;
      xmlParser.parse(xmlContent);
    } catch(e) {
      console.log(e, e.stack);
      if (e.$loc != null) {
        let $loc = e.$loc as SourceLocation;
        errors.push({msg:""+e, path:$loc.path, line:$loc.line});
      } else {
        errors.push({line:0,msg:""+e});
      }
      return {errors:errors, listings:listings};
    } finally {
      endtime("parse");
    }
    return {
      output: xmlParser,
      errors: errors,
      listings: listings,
    };
  }
}

// TODO: test
function compileYosys(step:BuildStep) {
  loadNative("yosys");
  var code = step.code;
  var errors = [];
  var match_fn = makeErrorMatcher(errors, /ERROR: (.+?) in line (.+?[.]v):(\d+)[: ]+(.+)/i, 3, 4, step.path);
  starttime();
  var yosys_mod : EmscriptenModule = emglobal.yosys({
    instantiateWasm: moduleInstFn('yosys'),
    noInitialRun:true,
    print:print_fn,
    printErr:match_fn,
  });
  endtime("create module");
  var topmod = detectTopModuleName(code);
  var FS = yosys_mod.FS;
  FS.writeFile(topmod+".v", code);
  starttime();
  try {
    execMain(step, yosys_mod, ["-q", "-o", topmod+".json", "-S", topmod+".v"]);
  } catch (e) {
    console.log(e);
    endtime("compile");
    return {errors:errors};
  }
  endtime("compile");
  //TODO: filename in errors
  if (errors.length) return {errors:errors};
  try {
    var json_file = FS.readFile(topmod+".json", {encoding:'utf8'});
    var json = JSON.parse(json_file);
    console.log(json);
    return {yosys_json:json, errors:errors}; // TODO
  } catch(e) {
    console.log(e);
    return {errors:errors};
  }
}

function assembleZMAC(step:BuildStep) {
  loadNative("zmac");
  var hexout, lstout, binout;
  var errors = [];
  var params = step.params;
  gatherFiles(step, {mainFilePath:"main.asm"});
  var lstpath = step.prefix + ".lst";
  var binpath = step.prefix + ".cim";
  if (staleFiles(step, [binpath, lstpath])) {
  /*
error1.asm(4) : 'l18d4' Undeclared
       JP      L18D4

error1.asm(11): warning: 'foobar' treated as label (instruction typo?)
	Add a colon or move to first column to stop this warning.
1 errors (see listing if no diagnostics appeared here)
  */
    var ZMAC : EmscriptenModule  = emglobal.zmac({
      instantiateWasm: moduleInstFn('zmac'),
      noInitialRun:true,
      //logReadFiles:true,
      print:print_fn,
      printErr:makeErrorMatcher(errors, /([^( ]+)\s*[(](\d+)[)]\s*:\s*(.+)/, 2, 3, step.path),
    });
    var FS = ZMAC.FS;
    populateFiles(step, FS);
    // TODO: don't know why CIM (hexary) doesn't work
    execMain(step, ZMAC, ['-z', '-c', '--oo', 'lst,cim', step.path]);
    if (errors.length) {
      return {errors:errors};
    }
    lstout = FS.readFile("zout/"+lstpath, {encoding:'utf8'});
    binout = FS.readFile("zout/"+binpath, {encoding:'binary'});
    putWorkFile(binpath, binout);
    putWorkFile(lstpath, lstout);
    if (!anyTargetChanged(step, [binpath, lstpath]))
      return;
    //  230: 1739+7+x   017A  1600      L017A: LD      D,00h
    var lines = parseListing(lstout, /\s*(\d+):\s*([0-9a-f]+)\s+([0-9a-f]+)\s+(.+)/i, 1, 2, 3);
    var listings : CodeListingMap = {};
    listings[lstpath] = {lines:lines};
    // parse symbol table
    var symbolmap = {};
    var sympos = lstout.indexOf('Symbol Table:');
    if (sympos > 0) {
      var symout = lstout.slice(sympos+14);
      symout.split('\n').forEach(function(l) {
        var m = l.match(/(\S+)\s+([= ]*)([0-9a-f]+)/i);
        if (m) {
          symbolmap[m[1]] = parseInt(m[3],16);
        }
      });
    }
    return {
      output:binout,
      listings:listings,
      errors:errors,
      symbolmap:symbolmap
    };
  }
}

function preprocessBatariBasic(code:string) : string {
  load("bbpreprocess");
  var bbout = "";
  function addbbout_fn(s) {
    bbout += s;
    bbout += "\n";
  }
  var BBPRE : EmscriptenModule = emglobal.preprocess({
    noInitialRun:true,
    //logReadFiles:true,
    print:addbbout_fn,
    printErr:print_fn,
    noFSInit:true,
  });
  var FS = BBPRE.FS;
  setupStdin(FS, code);
  BBPRE.callMain([]);
  console.log("preprocess " + code.length + " -> " + bbout.length + " bytes");
  return bbout;
}

function compileBatariBasic(step:BuildStep) {
  load("bb2600basic");
  var params = step.params;
  // stdout
  var asmout = "";
  function addasmout_fn(s) {
    asmout += s;
    asmout += "\n";
  }
  // stderr
  var re_err1 = /[(](\d+)[)]:?\s*(.+)/;
  var errors = [];
  var errline = 0;
  function match_fn(s) {
    console.log(s);
    var matches = re_err1.exec(s);
    if (matches) {
      errline = parseInt(matches[1]);
      errors.push({
        line:errline,
        msg:matches[2]
      });
    }
  }
  gatherFiles(step, {mainFilePath:"main.bas"});
  var destpath = step.prefix + '.asm';
  if (staleFiles(step, [destpath])) {
    var BB : EmscriptenModule = emglobal.bb2600basic({
      noInitialRun:true,
      //logReadFiles:true,
      print:addasmout_fn,
      printErr:match_fn,
      noFSInit:true,
      TOTAL_MEMORY:64*1024*1024,
    });
    var FS = BB.FS;
    populateFiles(step, FS);
    // preprocess, pipe file to stdin
    var code = getWorkFileAsString(step.path);
    code = preprocessBatariBasic(code);
    setupStdin(FS, code);
    setupFS(FS, '2600basic');
    execMain(step, BB, ["-i", "/share", step.path]);
    if (errors.length)
      return {errors:errors};
    // build final assembly output from include file list
    var includesout = FS.readFile("includes.bB", {encoding:'utf8'});
    var redefsout = FS.readFile("2600basic_variable_redefs.h", {encoding:'utf8'});
    var includes = includesout.trim().split("\n");
    var combinedasm = "";
    var splitasm = asmout.split("bB.asm file is split here");
    for (var incfile of includes) {
      var inctext;
      if (incfile=="bB.asm")
        inctext = splitasm[0];
      else if (incfile=="bB2.asm")
        inctext = splitasm[1];
      else
        inctext = FS.readFile("/share/includes/"+incfile, {encoding:'utf8'});
      console.log(incfile, inctext.length);
      combinedasm += "\n\n;;;" + incfile + "\n\n";
      combinedasm += inctext;
    }
    // TODO: ; bB.asm file is split here
    putWorkFile(destpath, combinedasm);
    putWorkFile("2600basic.h", FS.readFile("/share/includes/2600basic.h"));
    putWorkFile("2600basic_variable_redefs.h", redefsout);
  }
  return {
    nexttool:"dasm",
    path:destpath,
    args:[destpath],
    files:[destpath, "2600basic.h", "2600basic_variable_redefs.h"],
    bblines:true,
  };
}

function setupRequireFunction() {
  var exports = {};
  exports['jsdom'] = {
    JSDOM: function(a,b) {
      this.window = {};
    }
  };
  emglobal['require'] = (modname:string) => {
    console.log('require',modname,exports[modname]!=null);
    return exports[modname];
  }
}

function translateShowdown(step:BuildStep) {
  setupRequireFunction();
  load("showdown.min");
  var showdown = emglobal['showdown'];
  var converter = new showdown.Converter({
    tables:'true',
    smoothLivePreview:'true',
    requireSpaceBeforeHeadingText:'true',
    emoji:'true',
  });
  var code = getWorkFileAsString(step.path);
  var html = converter.makeHtml(code);
  delete emglobal['require'];
  return {
    output:html
  };
}

// http://datapipe-blackbeltsystems.com/windows/flex/asm09.html
function assembleXASM6809(step:BuildStep) {
  load("xasm6809");
  var alst = "";
  var lasterror = null;
  var errors = [];
  function match_fn(s) {
    alst += s;
    alst += "\n";
    if (lasterror) {
      var line = parseInt(s.slice(0,5)) || 0;
      errors.push({
        line:line,
        msg:lasterror
      });
      lasterror = null;
    }
    else if (s.startsWith("***** ")) {
      lasterror = s.slice(6);
    }
  }
  var Module : EmscriptenModule = emglobal.xasm6809({
    noInitialRun:true,
    //logReadFiles:true,
    print:match_fn,
    printErr:print_fn
  });
  var FS = Module.FS;
  //setupFS(FS);
  populateFiles(step, FS, {
    mainFilePath:'main.asm'
  });
  var binpath = step.prefix + '.bin';
  var lstpath = step.prefix + '.lst'; // in stdout
  execMain(step, Module, ["-c", "-l", "-s", "-y", "-o="+binpath, step.path]);
  if (errors.length)
    return {errors:errors};
  var aout = FS.readFile(binpath, {encoding:'binary'});
  if (aout.length == 0) {
    console.log(alst);
    errors.push({line:0, msg:"Empty output file"});
    return {errors:errors};
  }
  putWorkFile(binpath, aout);
  putWorkFile(lstpath, alst);
  // TODO: symbol map
  //mond09     0000     
  var symbolmap = {};
  //00005  W 0003 [ 8] A6890011            lda   >PALETTE,x
  //00012    0011      0C0203              fcb   12,2,3
  var asmlines = parseListing(alst, /^\s*([0-9]+) .+ ([0-9A-F]+)\s+\[([0-9 ]+)\]\s+([0-9A-F]+) (.*)/i, 1, 2, 4, 3);
  var listings : CodeListingMap = {};
  listings[step.prefix+'.lst'] = {lines:asmlines, text:alst};
  return {
    output:aout,
    listings:listings,
    errors:errors,
    symbolmap:symbolmap,
  };
}

// http://www.nespowerpak.com/nesasm/
function assembleNESASM(step:BuildStep) {
  loadNative("nesasm");
  var re_filename = /\#\[(\d+)\]\s+(\S+)/;
  var re_insn     = /\s+(\d+)\s+([0-9A-F]+):([0-9A-F]+)/;
  var re_error    = /\s+(.+)/;
  var errors : WorkerError[] = [];
  var state = 0;
  var lineno = 0;
  var filename;
  function match_fn(s) {
    var m;
    switch (state) {
      case 0:
        m = re_filename.exec(s);
        if (m) {
          filename = m[2];
        }
        m = re_insn.exec(s);
        if (m) {
          lineno = parseInt(m[1]);
          state = 1;
        }
        break;
      case 1:
        m = re_error.exec(s);
        if (m) {
          errors.push({path:filename, line:lineno, msg:m[1]});
          state = 0;
        }
        break;
    }
  }
  var Module : EmscriptenModule = emglobal.nesasm({
    instantiateWasm: moduleInstFn('nesasm'),
    noInitialRun:true,
    print:match_fn
  });
  var FS = Module.FS;
  populateFiles(step, FS, {
    mainFilePath:'main.a'
  });
  var binpath = step.prefix+'.nes';
  var lstpath = step.prefix+'.lst';
  var sympath = step.prefix+'.fns';
  execMain(step, Module, [step.path, '-s', "-l", "2" ]);
  // parse main listing, get errors and listings for each file
  var listings : CodeListingMap = {};
  try {
    var alst = FS.readFile(lstpath, {'encoding':'utf8'});
    //   16  00:C004  8E 17 40    STX $4017    ; disable APU frame IRQ
    var asmlines = parseListing(alst, /^\s*(\d+)\s+([0-9A-F]+):([0-9A-F]+)\s+([0-9A-F ]+?)  (.*)/i, 1, 3, 4);
    putWorkFile(lstpath, alst);
    listings[lstpath] = {
      lines:asmlines,
      text:alst
    };
  } catch (e) {
    //
  }
  if (errors.length) {
    return {errors:errors};
  }
  // read binary rom output and symbols
  var aout, asym;
  aout = FS.readFile(binpath);
  try {
    asym = FS.readFile(sympath, {'encoding':'utf8'});
  } catch (e) {
    console.log(e);
    errors.push({line:0,msg:"No symbol table generated, maybe missing ENDM or segment overflow?"});
    return {errors:errors}
  }
  putWorkFile(binpath, aout);
  putWorkFile(sympath, asym);
  if (alst) putWorkFile(lstpath, alst); // listing optional (use LIST)
  // return unchanged if no files changed
  if (!anyTargetChanged(step, [binpath, sympath]))
    return;
  // parse symbols
  var symbolmap = {};
  for (var s of asym.split("\n")) {
    if (!s.startsWith(';')) {
      var m = /(\w+)\s+=\s+[$]([0-9A-F]+)/.exec(s);
      if (m) {
        symbolmap[m[1]] = parseInt(m[2], 16);
      }
    }
  }
  return {
    output:aout,
    listings:listings,
    errors:errors,
    symbolmap:symbolmap,
  };
}

function compileCMOC(step:BuildStep) {
  loadNative("cmoc");
  var params = step.params;
  // stderr
  var re_err1 = /^[/]*([^:]*):(\d+): (.+)$/;
  var errors : WorkerError[] = [];
  var errline = 0;
  function match_fn(s) {
    var matches = re_err1.exec(s);
    if (matches) {
      errors.push({
        line:parseInt(matches[2]),
        msg:matches[3],
        path:matches[1] || step.path
      });
    } else {
      console.log(s);
    }
  }
  gatherFiles(step, {mainFilePath:"main.c"});
  var destpath = step.prefix + '.s';
  if (staleFiles(step, [destpath])) {
    var args = ['-S', '-Werror', '-V',
      '-I/share/include',
      '-I.',
      step.path];
    var CMOC : EmscriptenModule = emglobal.cmoc({
      instantiateWasm: moduleInstFn('cmoc'),
      noInitialRun:true,
      //logReadFiles:true,
      print:match_fn,
      printErr:match_fn,
    });
    // load source file and preprocess
    var code = getWorkFileAsString(step.path);
    var preproc = preprocessMCPP(step, null);
    if (preproc.errors) return preproc;
    else code = preproc.code;
    // set up filesystem
    var FS = CMOC.FS;
    //setupFS(FS, '65-'+getRootBasePlatform(step.platform));
    populateFiles(step, FS);
    FS.writeFile(step.path, code);
    fixParamsWithDefines(step.path, params);
    if (params.extra_compile_args) {
      args.unshift.apply(args, params.extra_compile_args);
    }
    execMain(step, CMOC, args);
    if (errors.length)
      return {errors:errors};
    var asmout = FS.readFile(destpath, {encoding:'utf8'});
    putWorkFile(destpath, asmout);
  }
  return {
    nexttool:"lwasm",
    path:destpath,
    args:[destpath],
    files:[destpath],
  };
}

function assembleLWASM(step:BuildStep) {
  loadNative("lwasm");
  var errors = [];
  gatherFiles(step, {mainFilePath:"main.s"});
  var objpath = step.prefix+".o";
  var lstpath = step.prefix+".lst";
  if (staleFiles(step, [objpath, lstpath])) {
    var objout, lstout;
    var args = ['-9', '--obj', '-I/share/asminc', '-o'+objpath, '-l'+lstpath, step.path];
    var LWASM : EmscriptenModule = emglobal.lwasm({
      instantiateWasm: moduleInstFn('lwasm'),
      noInitialRun:true,
      //logReadFiles:true,
      print:print_fn,
      printErr:msvcErrorMatcher(errors),
    });
    var FS = LWASM.FS;
    //setupFS(FS, '65-'+getRootBasePlatform(step.platform));
    populateFiles(step, FS);
    fixParamsWithDefines(step.path, step.params);
    execMain(step, LWASM, args);
    if (errors.length)
      return {errors:errors};
    objout = FS.readFile(objpath, {encoding:'binary'});
    lstout = FS.readFile(lstpath, {encoding:'utf8'});
    putWorkFile(objpath, objout);
    putWorkFile(lstpath, lstout);
  }
  return {
    linktool:"lwlink",
    files:[objpath, lstpath],
    args:[objpath]
  };
}

function linkLWLINK(step:BuildStep) {
  loadNative("lwlink");
  var params = step.params;
  gatherFiles(step);
  var binpath = "main";
  if (staleFiles(step, [binpath])) {
    var errors = [];
    var LWLINK : EmscriptenModule = emglobal.lwlink({
      instantiateWasm: moduleInstFn('lwlink'),
      noInitialRun:true,
      //logReadFiles:true,
      print:print_fn,
      printErr:function(s) {
        if (s.startsWith("Warning:"))
          console.log(s);
        else
          errors.push({msg:s,line:0});
      }
    });
    var FS = LWLINK.FS;
    //setupFS(FS, '65-'+getRootBasePlatform(step.platform));
    populateFiles(step, FS);
    populateExtraFiles(step, FS, params.extra_link_files);
    var libargs = params.extra_link_args || [];
    var args = [
      '-L.',
      '--entry=program_start',
      '--raw',
      '--output=main',
      '--map=main.map'].concat(libargs, step.args);
    console.log(args);
    execMain(step, LWLINK, args);
    if (errors.length)
      return {errors:errors};
    var aout = FS.readFile("main", {encoding:'binary'});
    var mapout = FS.readFile("main.map", {encoding:'utf8'});
    putWorkFile("main", aout);
    putWorkFile("main.map", mapout);
    // return unchanged if no files changed
    if (!anyTargetChanged(step, ["main", "main.map"]))
      return;
    // parse symbol map
    //console.log(mapout);
    var symbolmap = {};
    var segments = [];
    for (var s of mapout.split("\n")) {
      var toks = s.split(" ");
      // TODO: use regex
      if (toks[0] == 'Symbol:') {
        let ident = toks[1];
        let ofs = parseInt(toks[4], 16);
        if (ident && ofs >= 0 && !ident.startsWith("l_") && !/^L\d+$/.test(ident)) {
          symbolmap[ident] = ofs;
        }
      }
      else if (toks[0] == 'Section:') {
        let seg = toks[1];
        let segstart = parseInt(toks[5], 16);
        let segsize = parseInt(toks[7], 16);
        segments.push({name:seg, start:segstart, size:segsize});
      }
    }
    // build listings
    var listings : CodeListingMap = {};
    for (var fn of step.files) {
      if (fn.endsWith('.lst')) {
        // TODO
        var lstout = FS.readFile(fn, {encoding:'utf8'});
        var asmlines = parseListing(lstout, /^([0-9A-F]+)\s+([0-9A-F]+)\s+[(]\s*(.+?)[)]:(\d+) (.*)/i, 4, 1, 2, 3);
        // * Line //threed.c:117: init of variable e
        var srclines = parseSourceLines(lstout, /Line .+?:(\d+)/i, /^([0-9A-F]{4})/i);
        putWorkFile(fn, lstout);
        // TODO: you have to get rid of all source lines to get asm listing
        listings[fn] = {
          asmlines:srclines.length ? asmlines : null,
          lines:srclines.length ? srclines : asmlines,
          text:lstout
        };
      }
    }
    return {
      output:aout, //.slice(0),
      listings:listings,
      errors:errors,
      symbolmap:symbolmap,
      segments:segments
    };
  }
}

// http://www.techhelpmanual.com/829-program_startup___exit.html
function compileSmallerC(step:BuildStep) {
  loadNative("smlrc");
  var params = step.params;
  // stderr
  var re_err1 = /^Error in "[/]*(.+)" [(](\d+):(\d+)[)]/;
  var errors : WorkerError[] = [];
  var errline = 0;
  var errpath = step.path;
  function match_fn(s) {
    var matches = re_err1.exec(s);
    if (matches) {
      errline = parseInt(matches[2]);
      errpath = matches[1];
    } else {
      errors.push({
        line:errline,
        msg:s,
        path:errpath,
      });
    }
  }
  gatherFiles(step, {mainFilePath:"main.c"});
  var destpath = step.prefix + '.asm';
  if (staleFiles(step, [destpath])) {
    var args = ['-seg16',
      //'-nobss',
      '-no-externs',
      step.path, destpath];
    var smlrc : EmscriptenModule = emglobal.smlrc({
      instantiateWasm: moduleInstFn('smlrc'),
      noInitialRun:true,
      //logReadFiles:true,
      print:match_fn,
      printErr:match_fn,
    });
    // load source file and preprocess
    var code = getWorkFileAsString(step.path);
    var preproc = preprocessMCPP(step, null);
    if (preproc.errors) return preproc;
    else code = preproc.code;
    // set up filesystem
    var FS = smlrc.FS;
    //setupFS(FS, '65-'+getRootBasePlatform(step.platform));
    populateFiles(step, FS);
    FS.writeFile(step.path, code);
    fixParamsWithDefines(step.path, params);
    if (params.extra_compile_args) {
      args.unshift.apply(args, params.extra_compile_args);
    }
    execMain(step, smlrc, args);
    if (errors.length)
      return {errors:errors};
    var asmout = FS.readFile(destpath, {encoding:'utf8'});
    putWorkFile(destpath, asmout);
  }
  return {
    nexttool:"yasm",
    path:destpath,
    args:[destpath],
    files:[destpath],
  };
}
function assembleYASM(step:BuildStep) {
  loadNative("yasm");
  var errors = [];
  gatherFiles(step, {mainFilePath:"main.asm"});
  var objpath = step.prefix+".exe";
  var lstpath = step.prefix+".lst";
  var mappath = step.prefix+".map";
  if (staleFiles(step, [objpath])) {
    var args = [ '-X', 'vc',
      '-a', 'x86', '-f', 'dosexe', '-p', 'nasm',
      '-D', 'freedos',
      //'-g', 'dwarf2',
      //'-I/share/asminc',
      '-o', objpath, '-l', lstpath, '--mapfile='+mappath,
      step.path];
    // return yasm/*.ready*/
    var YASM : EmscriptenModule = emglobal.yasm({
      instantiateWasm: moduleInstFn('yasm'),
      noInitialRun:true,
      //logReadFiles:true,
      print:print_fn,
      printErr:msvcErrorMatcher(errors),
    });
    var FS = YASM.FS;
    //setupFS(FS, '65-'+getRootBasePlatform(step.platform));
    populateFiles(step, FS);
    //fixParamsWithDefines(step.path, step.params);
    execMain(step, YASM, args);
    if (errors.length)
      return {errors:errors};
    var objout, lstout, mapout;
    objout = FS.readFile(objpath, {encoding:'binary'});
    lstout = FS.readFile(lstpath, {encoding:'utf8'});
    mapout = FS.readFile(mappath, {encoding:'utf8'});
    putWorkFile(objpath, objout);
    putWorkFile(lstpath, lstout);
    //putWorkFile(mappath, mapout);
    if (!anyTargetChanged(step, [objpath]))
      return;
    var symbolmap = {};
    var segments = [];
    var lines = parseListing(lstout, /\s*(\d+)\s+([0-9a-f]+)\s+([0-9a-f]+)\s+(.+)/i, 1, 2, 3);
    var listings : CodeListingMap = {};
    listings[lstpath] = {lines:lines, text:lstout};
    return {
      output:objout, //.slice(0),
      listings:listings,
      errors:errors,
      symbolmap:symbolmap,
      segments:segments
    };
  }
}

interface XMLNode {
  type: string;
  text: string | null;
  children: XMLNode[];
}

function parseXMLPoorly(s: string) : XMLNode {
  var re = /[<]([/]?)([?a-z_-]+)([^>]*)[>]+|(\s*[^<]+)/gi;
  var m : RegExpMatchArray;
  //var i=0;
  var stack : XMLNode[] = [];
  while (m = re.exec(s)) {
    var [_m0,close,ident,attrs,content] = m;
    //if (i++<100) console.log(close,ident,attrs,content);
    if (close) {
      var top = stack.pop();
      if (top.type != ident) throw "mismatch close tag: " + ident;
      stack[stack.length-1].children.push(top);
    } else if (ident) {
      stack.push({type:ident, text:null, children:[]});
    } else if (content != null) {
      stack[stack.length-1].text = (content as string).trim();
    }
  }
  return top;
}

function compileInform6(step:BuildStep) {
  loadNative("inform");
  var errors = [];
  gatherFiles(step, {mainFilePath:"main.inf"});
  var objpath = step.prefix+".z5";
  if (staleFiles(step, [objpath])) {
    var errorMatcher = msvcErrorMatcher(errors);
    var lstout = "";
    var match_fn = (s: string) => {
      if (s.indexOf("Error:") >= 0) {
        errorMatcher(s);
      } else {
        lstout += s;
        lstout += "\n";
      }
    }
    // TODO: step.path must end in '.inf' or error
    var args = [ '-afjnops', '-v5', '-Cu', '-E1', '-k', '+/share/lib', step.path ];
    var inform : EmscriptenModule = emglobal.inform({
      instantiateWasm: moduleInstFn('inform'),
      noInitialRun:true,
      //logReadFiles:true,
      print:match_fn,
      printErr:match_fn,
    });
    var FS = inform.FS;
    setupFS(FS, 'inform');
    populateFiles(step, FS);
    //fixParamsWithDefines(step.path, step.params);
    execMain(step, inform, args);
    if (errors.length)
      return {errors:errors};
    var objout = FS.readFile(objpath, {encoding:'binary'});
    putWorkFile(objpath, objout);
    if (!anyTargetChanged(step, [objpath]))
      return;

    // parse debug XML
    var symbolmap = {};
    var segments : Segment[] = [];
    var entitymap = {
      // number -> string
      'object':{}, 'property':{}, 'attribute':{}, 'constant':{}, 'global-variable':{}, 'routine':{},
    };
    var dbgout = FS.readFile("gameinfo.dbg", {encoding:'utf8'});
    var xmlroot = parseXMLPoorly(dbgout);
    //console.log(xmlroot);
    var segtype = "ram";
    xmlroot.children.forEach((node) => {
      switch (node.type) {
        case 'global-variable':
        case 'routine':
          var ident = node.children.find((c,v) => c.type=='identifier').text;
          var address = parseInt(node.children.find((c,v) => c.type=='address').text);
          symbolmap[ident] = address;
          entitymap[node.type][address] = ident;
          break;
        case 'object':
        case 'property':
        case 'attribute':
          var ident = node.children.find((c,v) => c.type=='identifier').text;
          var value = parseInt(node.children.find((c,v) => c.type=='value').text);
          //entitymap[node.type][ident] = value;
          entitymap[node.type][value] = ident;
          //symbolmap[ident] = address | 0x1000000;
          break;
        case 'story-file-section':
          var name = node.children.find((c,v) => c.type=='type').text;
          var address = parseInt(node.children.find((c,v) => c.type=='address').text);
          var endAddress = parseInt(node.children.find((c,v) => c.type=='end-address').text);
          if (name == "grammar table") segtype = "rom";
          segments.push({name:name, start:address, size:endAddress-address, type:segtype});
      }
    });
    // parse listing
    var listings : CodeListingMap = {};
    //    35  +00015 <*> call_vs      long_19 location long_424 -> sp 
    var lines = parseListing(lstout, /\s*(\d+)\s+[+]([0-9a-f]+)\s+([<*>]*)\s*(\w+)\s+(.+)/i, -1, 2, 4);
    var lstpath = step.prefix + '.lst';
    listings[lstpath] = {lines:[], asmlines:lines, text:lstout};
    return {
      output:objout, //.slice(0),
      listings:listings,
      errors:errors,
      symbolmap:symbolmap,
      segments:segments,
      debuginfo:entitymap,
    };
  }
}

/*
------+-------------------+-------------+----+---------+------+-----------------------+-------------------------------------------------------------------
 Line | # File       Line | Line Type   | MX |  Reloc  | Size | Address   Object Code |  Source Code                                                      
------+-------------------+-------------+----+---------+------+-----------------------+-------------------------------------------------------------------
    1 |  1 zap.asm      1 | Unknown     | ?? |         |   -1 | 00/FFFF               |             broak                       
    2 |  1 zap.asm      2 | Comment     | ?? |         |   -1 | 00/FFFF               | * SPACEGAME
    
      => [Error] Impossible to decode address mode for instruction 'BNE  KABOOM!' (line 315, file 'zap.asm') : The number of element in 'KABOOM!' is even (should be value [operator value [operator value]...]).
      => [Error] Unknown line 'foo' in source file 'zap.asm' (line 315)
          => Creating Object file 'pcs.bin'
          => Creating Output file 'pcs.bin_S01__Output.txt'

*/
function assembleMerlin32(step:BuildStep) {
  loadNative("merlin32");
  var errors = [];
  var lstfiles = [];
  gatherFiles(step, {mainFilePath:"main.lnk"});
  var objpath = step.prefix+".bin";
  if (staleFiles(step, [objpath])) {
    var args = [ '-v', step.path ];
    var merlin32 : EmscriptenModule = emglobal.merlin32({
      instantiateWasm: moduleInstFn('merlin32'),
      noInitialRun:true,
      print:(s:string) => {
        var m = /\s*=>\s*Creating Output file '(.+?)'/.exec(s);
        if (m) {
          lstfiles.push(m[1]);
        }
        var errpos = s.indexOf('Error');
        if (errpos >= 0) {
          s = s.slice(errpos+6).trim();
          var mline = /\bline (\d+)\b/.exec(s);
          var mpath = /\bfile '(.+?)'/.exec(s);
          errors.push({
            line:parseInt(mline[1]) || 0,
            msg:s,
            path:mpath[1] || step.path,
          });
        }
      },
      printErr:print_fn,
    });
    var FS = merlin32.FS;
    populateFiles(step, FS);
    execMain(step, merlin32, args);
    if (errors.length)
      return {errors:errors};

    var errout = null;
    try {
      errout = FS.readFile("error_output.txt", {encoding:'utf8'});
    } catch (e) {
      //
    }

    var objout = FS.readFile(objpath, {encoding:'binary'});
    putWorkFile(objpath, objout);
    if (!anyTargetChanged(step, [objpath]))
      return;

    var symbolmap = {};
    var segments = [];
    var listings : CodeListingMap = {};
    lstfiles.forEach((lstfn) => {
      var lst = FS.readFile(lstfn, {encoding:'utf8'}) as string;
      lst.split('\n').forEach((line) => {
        var toks = line.split(/\s*\|\s*/);
        if (toks && toks[6]) {
          var toks2 = toks[1].split(/\s+/);
          var toks3 = toks[6].split(/[:/]/, 4);
          var path = toks2[1];
          if (path && toks2[2] && toks3[1]) {
            var lstline = {
              line:parseInt(toks2[2]),
              offset:parseInt(toks3[1].trim(),16),
              insns:toks3[2],
              cycles:null,
              iscode:false // TODO
            };
            var lst = listings[path];
            if (!lst) listings[path] = lst = {lines:[]};
            lst.lines.push(lstline);
            //console.log(path,toks2,toks3);
          }
        }
      });
    });
    return {
      output:objout, //.slice(0),
      listings:listings,
      errors:errors,
      symbolmap:symbolmap,
      segments:segments
    };
  }
}

// README.md:2:5: parse error, expected: statement or variable assignment, integer variable, variable assignment
function compileFastBasic(step:BuildStep) {
  // TODO: fastbasic-fp?
  loadNative("fastbasic-int");
  var params = step.params;
  gatherFiles(step, {mainFilePath:"main.fb"});
  var destpath = step.prefix + '.s';
  var errors = [];
  if (staleFiles(step, [destpath])) {
    var fastbasic : EmscriptenModule = emglobal.fastbasic({
      instantiateWasm: moduleInstFn('fastbasic-int'),
      noInitialRun:true,
      print:print_fn,
      printErr:makeErrorMatcher(errors, /(.+?):(\d+):(\d+):\s*(.+)/, 2, 4, step.path, 1),
    });
    var FS = fastbasic.FS;
    populateFiles(step, FS);
    var libfile = 'fastbasic-int.lib'
    params.libargs = [libfile];
    params.cfgfile = params.fastbasic_cfgfile;
    //params.extra_compile_args = ["--asm-define", "NO_SMCODE"];
    params.extra_link_files = [libfile, params.cfgfile];
    //fixParamsWithDefines(step.path, params);
    var args = [step.path, destpath];
    execMain(step, fastbasic, args);
    if (errors.length)
      return {errors:errors};
    var asmout = FS.readFile(destpath, {encoding:'utf8'});
    putWorkFile(destpath, asmout);
  }
  return {
    nexttool:"ca65",
    path:destpath,
    args:[destpath],
    files:[destpath],
  };
}

import * as basic_compiler from '../common/basic/compiler';

function compileBASIC(step:BuildStep) {
  var jsonpath = step.path + ".json";
  gatherFiles(step);
  if (staleFiles(step, [jsonpath])) {
    var parser = new basic_compiler.BASICParser();
    var code = getWorkFileAsString(step.path);
    try {
      var ast = parser.parseFile(code, step.path);
    } catch (e) {
      console.log(e);
      if (parser.errors.length == 0) throw e;
    }
    if (parser.errors.length) {
      return {errors: parser.errors};
    }
    // put AST into JSON (sans source locations) to see if it has changed
    var json = JSON.stringify(ast, (key,value) => { return (key=='$loc'?undefined:value) });
    putWorkFile(jsonpath, json);
    if (anyTargetChanged(step, [jsonpath])) return {
      output: ast,
      listings: parser.getListings(),
    };
  }
}

function compileSilice(step:BuildStep) {
  loadNative("silice");
  var params = step.params;
  gatherFiles(step, {mainFilePath:"main.ice"});
  var destpath = step.prefix + '.v';
  var errors : WorkerError[] = [];
  var errfile : string;
  var errline : number;
  if (staleFiles(step, [destpath])) {
    //[preprocessor] 97]  attempt to concatenate a nil value (global 'addrW')
    var match_fn = (s: string) => {
      s = (s as any).replaceAll(/\033\[\d+\w/g, '');
      var mf = /file:\s*(\w+)/.exec(s);
      var ml = /line:\s+(\d+)/.exec(s);
      var preproc = /\[preprocessor\] (\d+)\] (.+)/.exec(s);
      if (mf) errfile = mf[1];
      else if (ml) errline = parseInt(ml[1]);
      else if (preproc) {
        errors.push({path:step.path, line:parseInt(preproc[1]), msg:preproc[2]});
      }
      else if (errfile && errline && s.length > 1) {
        if (s.length > 2) {
          errors.push({path:errfile+".ice", line:errline, msg:s});
        } else {
          errfile = null;
          errline = null;
        }
      }
      else console.log(s);
    }
    var silice : EmscriptenModule = emglobal.silice({
      instantiateWasm: moduleInstFn('silice'),
      noInitialRun:true,
      print:match_fn,
      printErr:match_fn,
    });
    var FS = silice.FS;
    setupFS(FS, 'Silice');
    populateFiles(step, FS);
    populateExtraFiles(step, FS, params.extra_compile_files);
    const FWDIR = '/share/frameworks';
    var args = [
      '-D', 'NTSC=1',
      '--frameworks_dir', FWDIR,
      '-f', `/8bitworkshop.v`,
      '-o', destpath,
      step.path];
    execMain(step, silice, args);
    if (errors.length)
      return {errors:errors};
    var vout = FS.readFile(destpath, {encoding:'utf8'});
    putWorkFile(destpath, vout);
  }
  return {
    nexttool:"verilator",
    path:destpath,
    args:[destpath],
    files:[destpath],
  };
}

function compileWiz(step:BuildStep) {
  loadNative("wiz");
  var params = step.params;
  gatherFiles(step, {mainFilePath:"main.wiz"});
  var destpath = step.prefix + (params.wiz_rom_ext || ".bin");
  var errors : WorkerError[] = [];
  if (staleFiles(step, [destpath])) {
    var wiz : EmscriptenModule = emglobal.wiz({
      instantiateWasm: moduleInstFn('wiz'),
      noInitialRun:true,
      print:print_fn,
      //test.wiz:2: error: expected statement, but got identifier `test`
      printErr:makeErrorMatcher(errors, /(.+?):(\d+):\s*(.+)/, 2, 3, step.path, 1),
    });
    var FS = wiz.FS;
    setupFS(FS, 'wiz');
    populateFiles(step, FS);
    populateExtraFiles(step, FS, params.extra_compile_files);
    const FWDIR = '/share/common';
    var args = [
      '-o', destpath,
      '-I', FWDIR + '/' + (params.wiz_inc_dir || step.platform),
      '-s', 'wla',
      '--color=none',
      step.path];
    args.push('--system', params.wiz_sys_type || params.arch);
    execMain(step, wiz, args);
    if (errors.length)
      return {errors:errors};
    var binout = FS.readFile(destpath, {encoding:'binary'});
    putWorkFile(destpath, binout);
    var dbgout = FS.readFile(step.prefix + '.sym', {encoding:'utf8'});
    var symbolmap = {};
    for (var s of dbgout.split("\n")) {
      var toks = s.split(/ /);
      // 00:4008 header.basic_start
      if (toks && toks.length >= 2) {
        var tokrange = toks[0].split(':');
        var start = parseInt(tokrange[1], 16);
        var sym = toks[1];
        symbolmap[sym] = start;
      }
    }
    return {
      output:binout, //.slice(0),
      errors:errors,
      symbolmap:symbolmap,
    };
  }
}

function assembleARMIPS(step:BuildStep) {
  loadNative("armips");
  var errors = [];
  gatherFiles(step, {mainFilePath:"main.asm"});
  var objpath = "main.bin";
  var lstpath = step.prefix + ".lst";
  var sympath = step.prefix + ".sym";
  //test.armips(3) error: Parse error '.arm'
  var error_fn = makeErrorMatcher(errors, /^(.+?)\((\d+)\)\s+(fatal error|error|warning):\s+(.+)/, 2, 4, step.path, 1);

  if (staleFiles(step, [objpath])) {
    var args = [ step.path, '-temp', lstpath, '-sym', sympath, '-erroronwarning' ];
    var armips : EmscriptenModule = emglobal.armips({
      instantiateWasm: moduleInstFn('armips'),
      noInitialRun:true,
      print:error_fn,
      printErr:error_fn,
    });
    
    var FS = armips.FS;
    var code = getWorkFileAsString(step.path);
    code = `.arm.little :: .create "${objpath}",0 :: ${code}
.close`;
    putWorkFile(step.path, code);
    populateFiles(step, FS);
    execMain(step, armips, args);
    if (errors.length)
      return {errors:errors};

    var objout = FS.readFile(objpath, {encoding:'binary'}) as Uint8Array;
    putWorkFile(objpath, objout);
    if (!anyTargetChanged(step, [objpath]))
      return;

    var symbolmap = {};
    var segments = [];
    var listings : CodeListingMap = {};
    var lstout = FS.readFile(lstpath, {encoding:'utf8'}) as string;
    var lines = lstout.split(re_crlf);
    //00000034 .word 0x11223344                                             ; /vidfill.armips line 25
    var re_asmline = /^([0-9A-F]+) (.+?); [/](.+?) line (\d+)/;
    var lastofs = -1;
    for (var line of lines) {
      var m;
      if (m = re_asmline.exec(line)) {
        var path = m[3];
        var path2 = getPrefix(path) + '.lst'; // TODO: don't rename listing
        var lst = listings[path2];
        if (lst == null) { lst = listings[path2] = {lines:[]}; }
        var ofs = parseInt(m[1], 16);
        if (lastofs == ofs) {
            lst.lines.pop(); // get rid of duplicate offset
        } else if (ofs > lastofs) {
          var lastline = lst.lines[lst.lines.length-1];
          if (lastline && !lastline.insns) {
            var insns = objout.slice(lastofs, ofs).reverse();
            lastline.insns = Array.from(insns).map((b) => hex(b,2)).join('');
          }
        }
        lst.lines.push({
          path: path,
          line: parseInt(m[4]),
          offset: ofs
        });
        lastofs = ofs;
      }
    }
    //listings[lstpath] = {lines:lstlines, text:lstout};

    var symout = FS.readFile(sympath, {encoding:'utf8'}) as string;
    //0000000C loop2
    //00000034 .dbl:0004
    var re_symline = /^([0-9A-F]+)\s+(.+)/;
    for (var line of symout.split(re_crlf)) {
      var m;
      if (m = re_symline.exec(line)) {
        symbolmap[m[2]] = parseInt(m[1], 16);
      }
    }

    return {
      output:objout, //.slice(0),
      listings:listings,
      errors:errors,
      symbolmap:symbolmap,
      segments:segments
    };
  }
}

function assembleVASMARM(step:BuildStep) {
  loadNative("vasmarm_std");
  /// error 2 in line 8 of "gfxtest.c": unknown mnemonic <ew>
  /// error 3007: undefined symbol <XXLOOP>
  /// TODO: match undefined symbols
  var re_err1 = /^(fatal error|error|warning)? (\d+) in line (\d+) of "(.+)": (.+)/;
  var re_err2 = /^(fatal error|error|warning)? (\d+): (.+)/;
  var re_undefsym = /symbol <(.+?)>/;
  var errors : WorkerError[] = [];
  var undefsyms = [];
  function findUndefinedSymbols(line:string) {
    // find undefined symbols in line
    undefsyms.forEach((sym) => {
      if (line.indexOf(sym) >= 0) {
        errors.push({
          path:curpath,
          line:curline,
          msg:"Undefined symbol: " + sym,
        })
      }
    });
  }
  function match_fn(s) {
    let matches = re_err1.exec(s);
    if (matches) {
      errors.push({
        line:parseInt(matches[3]),
        path:matches[4],
        msg:matches[5],
      });
    } else {
      matches = re_err2.exec(s);
      if (matches) {
        let m = re_undefsym.exec(matches[3]);
        if (m) {
          undefsyms.push(m[1]);
        } else {
          errors.push({
            line:0,
            msg:s,
          });
        }
      } else {
        console.log(s);
      }
    }
  }

  gatherFiles(step, {mainFilePath:"main.asm"});
  var objpath = step.prefix+".bin";
  var lstpath = step.prefix+".lst";

  if (staleFiles(step, [objpath])) {
    var args = [ '-Fbin', '-m7tdmi', '-x', '-wfail', step.path, '-o', objpath, '-L', lstpath ];
    var vasm : EmscriptenModule = emglobal.vasm({
      instantiateWasm: moduleInstFn('vasmarm_std'),
      noInitialRun:true,
      print:match_fn,
      printErr:match_fn,
    });

    var FS = vasm.FS;
    populateFiles(step, FS);
    execMain(step, vasm, args);
    if (errors.length) {
      return {errors:errors};
    }

    if (undefsyms.length == 0) {
      var objout = FS.readFile(objpath, {encoding:'binary'});
      putWorkFile(objpath, objout);
      if (!anyTargetChanged(step, [objpath]))
        return;
    }

    var lstout = FS.readFile(lstpath, {encoding:'utf8'});
    // 00:00000018 023020E0        	    14:  eor r3, r0, r2
    // Source: "vidfill.vasm"
    // 00: ".text" (0-40)
    // LOOP                            00:00000018
    // STACK                            S:20010000
    var symbolmap = {};
    var segments = []; // TODO
    var listings : CodeListingMap = {};
    // TODO: parse listings
    var re_asmline = /^(\d+):([0-9A-F]+)\s+([0-9A-F ]+)\s+(\d+)([:M])/;
    var re_secline = /^(\d+):\s+"(.+)"/;
    var re_nameline = /^Source:\s+"(.+)"/;
    var re_symline = /^(\w+)\s+(\d+):([0-9A-F]+)/;
    var re_emptyline = /^\s+(\d+)([:M])/;
    var curpath = step.path;
    var curline = 0;
    var sections = {};
    // map file and section indices -> names
    var lines : string[] = lstout.split(re_crlf);
    // parse lines
    var lstlines : SourceLine[] = [];
    for (var line of lines) {
      var m;
      if (m = re_secline.exec(line)) {
        sections[m[1]] = m[2];
      } else if (m = re_nameline.exec(line)) {
        curpath = m[1];
      } else if (m = re_symline.exec(line)) {
        symbolmap[m[1]] = parseInt(m[3], 16);
      } else if (m = re_asmline.exec(line)) {
        if (m[5] == ':') {
          curline = parseInt(m[4]);
        } else {
          // TODO: macro line
        }
        lstlines.push({
          path: curpath,
          line: curline,
          offset: parseInt(m[2], 16),
          insns: m[3].replaceAll(' ','')
        });
        findUndefinedSymbols(line);
      } else if (m = re_emptyline.exec(line)) {
        curline = parseInt(m[1]);
        findUndefinedSymbols(line);
      } else {
        //console.log(line);
      }
    }
    listings[lstpath] = {lines:lstlines, text:lstout};
    // catch-all if no error generated
    if (undefsyms.length && errors.length == 0) {
      errors.push({
        line: 0,
        msg: 'Undefined symbols: ' + undefsyms.join(', ')
      })
    }

    return {
      output:objout, //.slice(0x34),
      listings:listings,
      errors:errors,
      symbolmap:symbolmap,
      segments:segments
    };
  }
}

////////////////////////////

var TOOLS = {
  'dasm': assembleDASM,
  //'acme': assembleACME,
  //'plasm': compilePLASMA,
  'cc65': compileCC65,
  'ca65': assembleCA65,
  'ld65': linkLD65,
  //'z80asm': assembleZ80ASM,
  //'sccz80': compileSCCZ80,
  'sdasz80': assembleSDASZ80,
  'sdldz80': linkSDLDZ80,
  'sdcc': compileSDCC,
  'xasm6809': assembleXASM6809,
  'cmoc': compileCMOC,
  'lwasm': assembleLWASM,
  'lwlink': linkLWLINK,
  //'naken': assembleNAKEN,
  'verilator': compileVerilator,
  'yosys': compileYosys,
  //'caspr': compileCASPR,
  'jsasm': compileJSASMStep,
  'zmac': assembleZMAC,
  'nesasm': assembleNESASM,
  'smlrc': compileSmallerC,
  'yasm': assembleYASM,
  'bataribasic': compileBatariBasic,
  'markdown': translateShowdown,
  'inform6': compileInform6,
  'merlin32': assembleMerlin32,
  'fastbasic': compileFastBasic,
  'basic': compileBASIC,
  'silice': compileSilice,
  'wiz': compileWiz,
  'armips': assembleARMIPS,
  'vasmarm': assembleVASMARM,
}

var TOOL_PRELOADFS = {
  'cc65-apple2': '65-apple2',
  'ca65-apple2': '65-apple2',
  'cc65-c64': '65-c64',
  'ca65-c64': '65-c64',
  'cc65-nes': '65-nes',
  'ca65-nes': '65-nes',
  'cc65-atari8': '65-atari8',
  'ca65-atari8': '65-atari8',
  'cc65-vector': '65-sim6502',
  'ca65-vector': '65-sim6502',
  'cc65-atari7800': '65-sim6502',
  'ca65-atari7800': '65-sim6502',
  'cc65-devel': '65-sim6502',
  'ca65-devel': '65-sim6502',
  'ca65-vcs': '65-sim6502',
  'sdasz80': 'sdcc',
  'sdcc': 'sdcc',
  'sccz80': 'sccz80',
  'bataribasic': '2600basic',
  'inform6': 'inform',
  'fastbasic': '65-atari8',
  'silice': 'Silice',
  'wiz': 'wiz',
}

function handleMessage(data : WorkerMessage) : WorkerResult | {unchanged:true} {
  // preload file system
  if (data.preload) {
    var fs = TOOL_PRELOADFS[data.preload];
    if (!fs && data.platform)
      fs = TOOL_PRELOADFS[data.preload+'-'+getBasePlatform(data.platform)];
    if (!fs && data.platform)
      fs = TOOL_PRELOADFS[data.preload+'-'+getRootBasePlatform(data.platform)];
    if (fs && !fsMeta[fs])
      loadFilesystem(fs);
    return;
  }
  // clear filesystem? (TODO: buildkey)
  if (data.reset) {
    store.reset();
    return;
  }
  return builder.handleMessage(data);
}

if (ENVIRONMENT_IS_WORKER) {
  onmessage = function(e) {
    var result = handleMessage(e.data);
    if (result) {
      postMessage(result);
    }
  }
}

//}();
