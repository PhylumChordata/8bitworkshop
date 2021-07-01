
import { HDLAlwaysBlock, HDLArrayItem, HDLBinop, HDLBlock, HDLConstant, HDLDataType, HDLDataTypeObject, HDLExpr, HDLExtendop, HDLFile, HDLFuncCall, HDLHierarchyDef, HDLInstanceDef, HDLLogicType, HDLModuleDef, HDLNativeType, HDLPort, HDLSensItem, HDLSourceLocation, HDLTriop, HDLUnit, HDLUnop, HDLUnpackArray, HDLValue, HDLVariableDef, HDLVarRef, HDLWhileOp, isArrayType, isBinop, isBlock, isConstExpr, isFuncCall, isLogicType, isTriop, isUnop, isVarDecl, isVarRef } from "./hdltypes";

/**
 * Whaa?
 * 
 * Each hierarchy takes (uint32[] -> uint32[])
 * - convert to/from js object
 * - JS or WASM
 * - Fixed-size packets
 * - state is another uint32[]
 * Find optimal packing of bits
 * Find clocks
 * Find pivots (reset, state) concat them together
 * Dependency cycles
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer
 */

interface XMLNode {
    type: string;
    text: string | null;
    children: XMLNode[];
    attrs: { [id: string]: string };
    obj: any;
}

type XMLVisitFunction = (node: XMLNode) => any;

function escapeXML(s: string): string {
    if (s.indexOf('&') >= 0) {
        return s.replace(/&apos;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/&gt;/g, '>')
            .replace(/&lt;/g, '<')
            .replace(/&amp;/g, '&');
    } else {
        return s;
    }
}

function parseXMLPoorly(s: string, openfn?: XMLVisitFunction, closefn?: XMLVisitFunction): XMLNode {
    const tag_re = /[<]([/]?)([?a-z_-]+)([^>]*)[>]+|(\s*[^<]+)/gi;
    const attr_re = /\s*(\w+)="(.*?)"\s*/gi;
    var fm: RegExpMatchArray;
    var stack: XMLNode[] = [];
    var top: XMLNode;

    function closetop() {
        top = stack.pop();
        if (top.type != ident) throw Error("mismatch close tag: " + ident);
        if (closefn) {
            top.obj = closefn(top);
        }
        stack[stack.length - 1].children.push(top);
    }
    function parseattrs(as: string): { [id: string]: string } {
        var am;
        var attrs = {};
        if (as != null) {
            while (am = attr_re.exec(as)) {
                attrs[am[1]] = escapeXML(am[2]);
            }
        }
        return attrs;
    }
    while (fm = tag_re.exec(s)) {
        var [_m0, close, ident, attrs, content] = fm;
        //console.log(stack.length, close, ident, attrs, content);
        if (close) {
            closetop();
        } else if (ident) {
            var node = { type: ident, text: null, children: [], attrs: parseattrs(attrs), obj: null };
            stack.push(node);
            if (attrs) {
                parseattrs(attrs);
            }
            if (openfn) {
                node.obj = openfn(node);
            }
            if (attrs && attrs.endsWith('/')) closetop();
        } else if (content != null) {
            var txt = escapeXML(content as string).trim();
            if (txt.length) stack[stack.length - 1].text = txt;
        }
    }
    if (stack.length != 1) throw Error("tag not closed");
    if (stack[0].type != '?xml') throw Error("?xml needs to be first element");
    return top;
}

export class CompileError extends Error {
    $loc : HDLSourceLocation;
    constructor(msg: string, loc: HDLSourceLocation) {
        super(msg);
        Object.setPrototypeOf(this, CompileError.prototype);
        this.$loc = loc;
    }
}

export class VerilogXMLParser implements HDLUnit {

    files: { [id: string]: HDLFile } = {};
    dtypes: { [id: string]: HDLDataType } = {};
    modules: { [id: string]: HDLModuleDef } = {};
    hierarchies: { [id: string]: HDLHierarchyDef } = {};

    cur_node : XMLNode;
    cur_module : HDLModuleDef;
    cur_deferred = [];

    constructor() {
        // TODO: other types
        this.dtypes['IData'] = {left:31, right:0};
    }

    defer(fn: () => void) {
        this.cur_deferred.unshift(fn);
    }

    defer2(fn: () => void) {
        this.cur_deferred.push(fn);
    }

    run_deferred() {
        this.cur_deferred.forEach((fn) => fn());
        this.cur_deferred = [];
    }

    name2js(s: string) {
        return s.replace(/[^a-z0-9_]/gi, '$');
    }

    findChildren(node: XMLNode, type: string, required: boolean) : XMLNode[] {
        var arr = node.children.filter((n) => n.type == type);
        if (arr.length == 0 && required) throw Error(`no child of type ${type}`);
        return arr;
    }

    parseSourceLocation(node: XMLNode): HDLSourceLocation {
        var loc = node.attrs['loc'];
        if (loc) {
            var [fileid, line, col, end_line, end_col] = loc.split(',');
            return {
                file: this.files[fileid],
                line: parseInt(line),
                col: parseInt(col),
                end_line: parseInt(line),
                end_col: parseInt(col),
            }
        } else {
            return null;
        }
    }

    open_module(node: XMLNode) {
        var module: HDLModuleDef = {
            $loc: this.parseSourceLocation(node),
            name: node.attrs['name'],
            origName: node.attrs['origName'],
            blocks: [],
            instances: [],
            vardefs: {},
        }
        this.cur_module = module;
        return module;
    }

    deferDataType(node: XMLNode, def: HDLDataTypeObject) {
        var dtype_id = node.attrs['dtype_id'];
        if (dtype_id != null) {
            this.defer(() => {
                def.dtype = this.dtypes[dtype_id];
                if (!def.dtype) {
                    console.log(node);
                    throw Error(`Unknown data type ${dtype_id} for ${node.type}`);
                }
            })
        }
    }

    parseConstValue(s: string) : number {
        const re_const = /(\d+)'([s]?)h([0-9a-f]+)/i;
        var m = re_const.exec(s);
        if (m) {
            return parseInt(m[3], 16);
        } else {
            throw Error(`could not parse constant "${s}"`);
        }
    }
    
    resolveVar(s: string, mod: HDLModuleDef) : HDLVariableDef {
        var def = mod.vardefs[s];
        if (def == null) throw Error(`could not resolve variable "${s}"`);
        return def;
    }

    resolveModule(s: string) : HDLModuleDef {
        var mod = this.modules[s];
        if (mod == null) throw Error(`could not resolve module "${s}"`);
        return mod;
    }

    //

    visit_verilator_xml(node: XMLNode) {
    }

    visit_module(node: XMLNode) {
        this.findChildren(node, 'var', false).forEach((n) => {
            if (isVarDecl(n.obj)) {
                this.cur_module.vardefs[n.obj.name] = n.obj;
            }
        })
        this.modules[this.cur_module.name] = this.cur_module;
        this.cur_module = null;
    }

    visit_var(node: XMLNode) : HDLVariableDef {
        var name = node.attrs['name'];
        name = this.name2js(name);
        var vardef: HDLVariableDef = {
            $loc: this.parseSourceLocation(node),
            name: name,
            origName: node.attrs['origName'],
            isInput: node.attrs['dir'] == 'input',
            isOutput: node.attrs['dir'] == 'output',
            isParam: node.attrs['param'] == 'true',
            dtype: null,
        }
        this.deferDataType(node, vardef);
        var const_nodes = this.findChildren(node, 'const', false);
        if (const_nodes.length) {
            vardef.constValue = const_nodes[0].obj;
        }
        var init_nodes = this.findChildren(node, 'initarray', false);
        if (init_nodes.length) {
            vardef.initValue = init_nodes[0].obj;
        }
        return vardef;
    }

    visit_const(node: XMLNode) : HDLConstant {
        var name = node.attrs['name'];
        var constdef: HDLConstant = {
            $loc: this.parseSourceLocation(node),
            dtype: null,
            cvalue: this.parseConstValue(name)
        }
        this.deferDataType(node, constdef);
        return constdef;
    }

    visit_varref(node: XMLNode) : HDLVarRef {
        var name = node.attrs['name'];
        name = this.name2js(name);
        var varref: HDLVarRef = {
            $loc: this.parseSourceLocation(node),
            dtype: null,
            refname: name
        }
        this.deferDataType(node, varref);
        var mod = this.cur_module;
        /*
        this.defer2(() => {
            varref.vardef = this.resolveVar(name, mod);
        });
        */
        return varref;
    }

    visit_sentree(node: XMLNode) {
        // TODO
    }

    visit_always(node: XMLNode) : HDLAlwaysBlock {
        // TODO
        var sentree : HDLSensItem[];
        var expr : HDLExpr;
        if (node.children.length == 2) {
            sentree = node.children[0].obj as HDLSensItem[];
            expr = node.children[1].obj as HDLExpr;
            // TODO: check sentree
        } else {
            sentree = null;
            expr = node.children[0].obj as HDLExpr;
        }
        var always: HDLAlwaysBlock = {
            $loc: this.parseSourceLocation(node),
            blocktype: node.type,
            name: null,
            senlist: sentree,
            exprs: [expr],
        };
        this.cur_module.blocks.push(always);
        return always;
    }

    visit_begin(node: XMLNode) : HDLBlock {
        var exprs = [];
        node.children.forEach((n) => exprs.push(n.obj));
        return {
            $loc: this.parseSourceLocation(node),
            blocktype: node.type,
            name: node.attrs['name'],
            exprs: exprs,
        }
    }

    visit_initarray(node: XMLNode) : HDLBlock {
        return this.visit_begin(node);
    }

    visit_inititem(node: XMLNode) : HDLArrayItem {
        if (node.children.length != 1) throw Error('expected 1 children');
        return {
            index: parseInt(node.attrs['index']),
            expr: node.children[0].obj
        }
    }

    visit_cfunc(node: XMLNode) : HDLBlock {
        var block = this.visit_begin(node);
        block.exprs = [];
        node.children.forEach((n) => block.exprs.push(n.obj));
        this.cur_module.blocks.push(block);
        return block;
    }

    visit_instance(node: XMLNode) : HDLInstanceDef {
        var instance : HDLInstanceDef = {
            $loc: this.parseSourceLocation(node),
            name: node.attrs['name'],
            origName: node.attrs['origName'],
            ports: [],
            module: null,
        }
        node.children.forEach((child) => {
            instance.ports.push(child.obj);
        })
        this.cur_module.instances.push(instance);
        this.defer(() => {
            instance.module = this.resolveModule(node.attrs['defName']);
        })
        return instance;
    }

    visit_port(node: XMLNode) : HDLPort {
        if (node.children.length != 1) throw Error('expected 1 children');
        var varref: HDLPort = {
            $loc: this.parseSourceLocation(node),
            name: node.attrs['name'],
            expr: node.children[0].obj
        }
        return varref;
    }

    visit_netlist(node: XMLNode) {
    }

    visit_files(node: XMLNode) {
    }

    visit_module_files(node: XMLNode) {
        node.children.forEach((n) => this.files[(n.obj as HDLFile).id].isModule = true);
    }

    visit_file(node: XMLNode) {
        return this.visit_file_or_module(node, false);
    }

    // TODO
    visit_scope(node: XMLNode) {
    }

    visit_topscope(node: XMLNode) {
    }

    visit_file_or_module(node: XMLNode, isModule: boolean) : HDLFile {
        var file : HDLFile = {
            id: node.attrs['id'],
            filename: node.attrs['filename'],
            isModule: isModule,
        }
        this.files[file.id] = file;
        return file;
    }

    visit_cells(node: XMLNode) {
        var hier = node.children[0].obj as HDLHierarchyDef;
        var hiername = hier.name;
        this.hierarchies[hiername] = hier;
    }

    visit_cell(node: XMLNode) : HDLHierarchyDef {
        var hier = {
            $loc: this.parseSourceLocation(node),
            name: node.attrs['name'],
            module: null,
            parent: null,
            children: node.children.map((n) => n.obj),
        }
        node.children.forEach((n) => (n.obj as HDLHierarchyDef).parent = hier);
        this.defer(() => {
            hier.module = this.resolveModule(node.attrs['submodname']);
        })
        return hier;
    }

    visit_basicdtype(node: XMLNode): HDLDataType {
        let id = node.attrs['id'];
        var dtype: HDLDataType;
        var dtypename = node.attrs['name'];
        switch (dtypename) {
            case 'logic':
            case 'integer': // TODO?
            case 'bit':
                let dlogic: HDLLogicType = {
                    $loc: this.parseSourceLocation(node),
                    left: parseInt(node.attrs['left'] || "0"),
                    right: parseInt(node.attrs['right'] || "0"),
                }
                dtype = dlogic;
                break;
            case 'string':
                let dstring: HDLNativeType = {
                    $loc: this.parseSourceLocation(node),
                    jstype: 'string'
                }
                dtype = dstring;
                break;
            default:
                dtype = this.dtypes[dtypename];
                if (dtype == null) {
                    console.log(node);
                    throw Error(`unknown data type ${dtypename}`);
                }
        }
        this.dtypes[id] = dtype;
        return dtype;
    }

    visit_unpackarraydtype(node: XMLNode): HDLDataType {
        let id = node.attrs['id'];
        let sub_dtype_id = node.attrs['sub_dtype_id'];
        let range = node.children[0].obj as HDLBinop;
        if (isConstExpr(range.left) && isConstExpr(range.right)) {
            var dtype: HDLUnpackArray = {
                $loc: this.parseSourceLocation(node),
                subtype: null,
                low: range.left,
                high: range.right,
            }
            this.dtypes[id] = dtype;
            this.defer(() => {
                dtype.subtype = this.dtypes[sub_dtype_id];
                if (!dtype.subtype) throw Error(`Unknown data type ${sub_dtype_id} for array`);
            })
            return dtype;
        } else {
            throw Error(`could not parse constant exprs in array`)
        }
    }

    visit_senitem(node: XMLNode) : HDLSensItem {
        var edgeType = node.attrs['edgeType'];
        if (edgeType != "POS" && edgeType != "NEG")
            throw Error("POS/NEG required")
        return {
            $loc: this.parseSourceLocation(node),
            edgeType: edgeType,
            expr: node.obj
        }
    }

    visit_text(node: XMLNode) {
    }

    visit_cstmt(node: XMLNode) {
    }

    visit_cfile(node: XMLNode) {
    }

    visit_typetable(node: XMLNode) {
    }

    visit_constpool(node: XMLNode) {
    }

    __visit_unop(node: XMLNode) : HDLUnop {
        if (node.children.length != 1) throw Error('expected 1 children');
        var expr: HDLUnop = {
            $loc: this.parseSourceLocation(node),
            op: node.type,
            dtype: null,
            left: node.children[0].obj as HDLExpr,
        }
        this.deferDataType(node, expr);
        return expr;
    }

    visit_extends(node: XMLNode) : HDLUnop {
        var unop = this.__visit_unop(node) as HDLExtendop;
        unop.width = parseInt(node.attrs['width']);
        unop.widthminv = parseInt(node.attrs['widthminv']);
        if (unop.width != 32) throw Error(`extends width ${unop.width} != 32`)
        return unop;
    }

    __visit_binop(node: XMLNode) : HDLBinop {
        if (node.children.length != 2) throw Error('expected 2 children');
        var expr: HDLBinop = {
            $loc: this.parseSourceLocation(node),
            op: node.type,
            dtype: null,
            left: node.children[0].obj as HDLExpr,
            right: node.children[1].obj as HDLExpr,
        }
        this.deferDataType(node, expr);
        return expr;
    }

    visit_if(node: XMLNode) : HDLTriop {
        if (node.children.length < 2 || node.children.length > 3) throw Error('expected 2 or 3 children');
        var expr: HDLTriop = {
            $loc: this.parseSourceLocation(node),
            op: 'if',
            dtype: null,
            cond: node.children[0].obj as HDLExpr,
            left: node.children[1].obj as HDLExpr,
            right: node.children[2] && node.children[2].obj as HDLExpr,
        }
        return expr;
    }

    // while and for loops
    visit_while(node: XMLNode) : HDLWhileOp {
        if (node.children.length < 2 || node.children.length > 4) throw Error('expected 2-4 children');
        var expr: HDLWhileOp = {
            $loc: this.parseSourceLocation(node),
            op: 'while',
            dtype: null,
            precond: node.children[0].obj as HDLExpr,
            loopcond: node.children[1].obj as HDLExpr,
            body: node.children[2] && node.children[2].obj as HDLExpr,
            inc: node.children[3] && node.children[3].obj as HDLExpr,
        }
        return expr;
    }

    __visit_triop(node: XMLNode) : HDLBinop {
        if (node.children.length != 3) throw Error('expected 2 children');
        var expr: HDLTriop = {
            $loc: this.parseSourceLocation(node),
            op: node.type,
            dtype: null,
            cond: node.children[0].obj as HDLExpr,
            left: node.children[1].obj as HDLExpr,
            right: node.children[2].obj as HDLExpr,
        }
        this.deferDataType(node, expr);
        return expr;
    }

    __visit_func(node: XMLNode) : HDLFuncCall {
        return {
            $loc: this.parseSourceLocation(node),
            funcname: node.attrs['func'] || ('$' + node.type),
            args: node.children.map(n => n.obj as HDLExpr)
        }
    }

    visit_not(node: XMLNode) { return this.__visit_unop(node); }
    visit_negate(node: XMLNode) { return this.__visit_unop(node); }
    visit_redand(node: XMLNode) { return this.__visit_unop(node); }
    visit_redor(node: XMLNode) { return this.__visit_unop(node); }
    visit_redxor(node: XMLNode) { return this.__visit_unop(node); }
    visit_initial(node: XMLNode) { return this.__visit_unop(node); }
    visit_ccast(node: XMLNode) { return this.__visit_unop(node); }
    visit_creset(node: XMLNode) { return this.__visit_unop(node); }
    visit_creturn(node: XMLNode) { return this.__visit_unop(node); }

    visit_contassign(node: XMLNode) { return this.__visit_binop(node); }
    visit_assigndly(node: XMLNode) { return this.__visit_binop(node); }
    visit_assignpre(node: XMLNode) { return this.__visit_binop(node); }
    visit_assignpost(node: XMLNode) { return this.__visit_binop(node); }
    visit_assign(node: XMLNode) { return this.__visit_binop(node); }
    visit_arraysel(node: XMLNode) { return this.__visit_binop(node); }
    visit_wordsel(node: XMLNode) { return this.__visit_binop(node); }

    visit_eq(node: XMLNode) { return this.__visit_binop(node); }
    visit_neq(node: XMLNode) { return this.__visit_binop(node); }
    visit_lte(node: XMLNode) { return this.__visit_binop(node); }
    visit_gte(node: XMLNode) { return this.__visit_binop(node); }
    visit_lt(node: XMLNode) { return this.__visit_binop(node); }
    visit_gt(node: XMLNode) { return this.__visit_binop(node); }
    visit_and(node: XMLNode) { return this.__visit_binop(node); }
    visit_or(node: XMLNode) { return this.__visit_binop(node); }
    visit_xor(node: XMLNode) { return this.__visit_binop(node); }
    visit_add(node: XMLNode) { return this.__visit_binop(node); }
    visit_sub(node: XMLNode) { return this.__visit_binop(node); }
    visit_concat(node: XMLNode) { return this.__visit_binop(node); } // TODO?
    visit_shiftl(node: XMLNode) { return this.__visit_binop(node); }
    visit_shiftr(node: XMLNode) { return this.__visit_binop(node); }

    visit_mul(node: XMLNode) { return this.__visit_binop(node); }
    visit_div(node: XMLNode) { return this.__visit_binop(node); }
    visit_moddiv(node: XMLNode) { return this.__visit_binop(node); }
    visit_muls(node: XMLNode) { return this.__visit_binop(node); }
    visit_divs(node: XMLNode) { return this.__visit_binop(node); }
    visit_moddivs(node: XMLNode) { return this.__visit_binop(node); }
    visit_gts(node: XMLNode) { return this.__visit_binop(node); }
    visit_lts(node: XMLNode) { return this.__visit_binop(node); }
    visit_gtes(node: XMLNode) { return this.__visit_binop(node); }
    visit_ltes(node: XMLNode) { return this.__visit_binop(node); }
    // TODO: more?

    visit_range(node: XMLNode) { return this.__visit_binop(node); }

    visit_cond(node: XMLNode) { return this.__visit_triop(node); }
    visit_condbound(node: XMLNode) { return this.__visit_triop(node); }
    visit_sel(node: XMLNode) { return this.__visit_triop(node); }

    visit_changedet(node: XMLNode) : HDLBinop {
        if (node.children.length == 0)
            return null; //{ op: "changedet", dtype:null, left:null, right:null }
        else
            return this.__visit_binop(node);
    }

    visit_ccall(node: XMLNode) { return this.__visit_func(node); }
    visit_finish(node: XMLNode) { return this.__visit_func(node); }
    visit_stop(node: XMLNode) { return this.__visit_func(node); }
    visit_rand(node: XMLNode) { return this.__visit_func(node); }
    visit_time(node: XMLNode) { return this.__visit_func(node); }

    visit_display(node: XMLNode) { return this.__visit_func(node); }
    visit_sformatf(node: XMLNode) { return this.visit_begin(node); }

    visit_readmem(node: XMLNode) { return this.__visit_func(node); }

    //

    xml_open(node: XMLNode) {
        this.cur_node = node;
        var method = this[`open_${node.type}`];
        if (method) {
            return method.bind(this)(node);
        }
    }
    
    xml_close(node: XMLNode) {
        this.cur_node = node;
        var method = this[`visit_${node.type}`];
        if (method) {
            return method.bind(this)(node);
        } else {
            console.log(node);
            throw Error(`no visitor for ${node.type}`)
        }
    }

    parse(xmls: string) {
        parseXMLPoorly(xmls, this.xml_open.bind(this), this.xml_close.bind(this));
        this.cur_node = null;
        this.run_deferred();
    }
}
