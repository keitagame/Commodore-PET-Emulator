// basic.js
export class Basic {
  constructor(terminal) {
    this.t = terminal;
    this.program = new Map(); // lineNumber -> {tokens, raw}
    this.vars = Object.create(null); // scalar numeric/string
    this.running = false;
    this.linesSorted = [];
  }

  reset() {
    this.program.clear();
    this.vars = Object.create(null);
    this.running = false;
    this.linesSorted = [];
  }

  tokenize(line) {
    const kw = ['PRINT','INPUT','LET','IF','THEN','GOTO','END','LIST','RUN','REM','STOP','FOR','TO','NEXT','GOSUB','RETURN'];
    const spaced = line.replace(/([=+\-*/(),<>])/g, ' $1 ');
    const parts = spaced.trim().split(/\s+/).map(s=>s.toUpperCase());
    return parts.map(p => kw.includes(p) ? {type:'KW', val:p} :
                       /^\d+$/.test(p) ? {type:'NUM', val:Number(p)} :
                       /^".*"$/.test(p) ? {type:'STR', val:p.slice(1,-1)} :
                       /^[A-Z][A-Z0-9]*$/.test(p) ? {type:'ID', val:p} :
                       {type:'SYM', val:p});
  }

  parseLine(raw) {
    const m = raw.match(/^\s*(\d+)\s*(.*)$/);
    if (m) {
      const ln = Number(m[1]);
      const rest = m[2];
      if (rest.trim()==='') { this.program.delete(ln); this._resort(); return {type:'STMT', action:'DELETE', ln}; }
      const tokens = this.tokenize(rest);
      this.program.set(ln, {tokens, raw:rest});
      this._resort();
      return {type:'STMT', action:'STORE', ln};
    } else {
      const tokens = this.tokenize(raw);
      return {type:'IMMEDIATE', tokens};
    }
  }

  _resort() {
    this.linesSorted = Array.from(this.program.keys()).sort((a,b)=>a-b);
  }

  async execImmediate(tokens) {
    await this.execTokens(tokens, {pcLineIndex:null});
  }

  async run() {
    this.running = true;
    const state = { pcLineIndex:0, callStack:[], loopStack:[] };
    while (this.running && state.pcLineIndex < this.linesSorted.length) {
      const ln = this.linesSorted[state.pcLineIndex];
      const {tokens} = this.program.get(ln);
      await this.execTokens(tokens, state, ln);
      state.pcLineIndex++;
    }
    this.t.printLine('READY.');
    this.running = false;
  }

  stop() { this.running = false; }

  evalExpr(tokens, i=0) {
    const readAtom = () => {
      const t = tokens[i];
      if (!t) throw new Error('Unexpected end of expr');
      if (t.type==='NUM') { i++; return t.val; }
      if (t.type==='STR') { i++; return t.val; }
      if (t.type==='ID') { i++; return (this.vars[t.val] ?? 0); }
      throw new Error('Bad token in expr: '+t.val);
    };
    let acc = readAtom();
    while (i < tokens.length && tokens[i].type==='SYM' && (tokens[i].val==='+' || tokens[i].val==='-')) {
      const op = tokens[i].val; i++;
      const rhs = readAtom();
      if (typeof acc === 'string' || typeof rhs === 'string') {
        if (op !== '+') throw new Error('String supports only +');
        acc = String(acc) + String(rhs);
      } else {
        acc = op==='+' ? acc+rhs : acc-rhs;
      }
    }
    return {value:acc, next:i};
  }

  async execTokens(tokens, state, currentLine=null) {
    let i = 0;
    const nextKW = () => (tokens[i] && tokens[i].type==='KW') ? tokens[i].val : null;

    const kw = nextKW();
    if (kw === 'REM') return;
    if (kw === 'LIST') { this.list(); return; }
    if (kw === 'RUN')  { await this.run(); return; }
    if (kw === 'STOP' || kw === 'END') { this.stop(); return; }

    if (kw === 'PRINT') {
      i++;
      const parts = [];
      while (i < tokens.length) {
        const {value, next} = this.evalExpr(tokens, i);
        parts.push(value);
        i = next;
        if (tokens[i]?.type==='SYM' && tokens[i].val===',') { i++; continue; }
        break;
      }
      this.t.printLine(parts.map(v=>String(v)).join(' '));
      return;
    }

    if (kw === 'LET' || (tokens[i]?.type==='ID' && tokens[i+1]?.type==='SYM' && tokens[i+1].val==='=')) {
      let varName;
      if (kw === 'LET') { i++; if (tokens[i]?.type!=='ID') throw new Error('LET needs variable'); varName = tokens[i].val; i++; }
      else { varName = tokens[i].val; i+=2; }
      const {value, next} = this.evalExpr(tokens, i);
      i = next;
      this.vars[varName] = value;
      return;
    }

    if (kw === 'INPUT') {
      i++;
      if (tokens[i]?.type!=='ID') throw new Error('INPUT needs variable');
      const varName = tokens[i].val; i++;
      const s = await this.t.readLine('? ');
      const num = Number(s.trim());
      this.vars[varName] = Number.isFinite(num) ? num : s.trim();
      return;
    }

    if (kw === 'IF') {
      i++;
      const {value, next} = this.evalExpr(tokens, i);
      i = next;
      if (tokens[i]?.type!=='KW' || tokens[i].val!=='THEN') throw new Error('IF needs THEN');
      i++;
      const targetTok = tokens[i];
      if (typeof value === 'number' && value !== 0) {
        if (targetTok?.type==='NUM') {
          await this.gotoLine(targetTok.val, state);
          return;
        } else {
          const rest = tokens.slice(i);
          await this.execTokens(rest, state, currentLine);
          return;
        }
      } else {
        return;
      }
    }

    if (kw === 'GOTO') {
      i++;
      const target = tokens[i];
      if (!target || target.type!=='NUM') throw new Error('GOTO needs line number');
      await this.gotoLine(target.val, state);
      return;
    }

    if (kw) throw new Error('Unknown/unsupported: '+kw);
  }

  list() {
    for (const ln of this.linesSorted) {
      const raw = this.program.get(ln).raw;
      this.t.printLine(`${ln} ${raw}`);
    }
  }

  async gotoLine(target, state) {
    const idx = this.linesSorted.indexOf(target);
    if (idx === -1) throw new Error(`Undefined line ${target}`);
    state.pcLineIndex = idx - 1;
  }
}
