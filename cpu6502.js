// cpu6502.js
export class CPU6502 {
  constructor(bus) {
    this.bus = bus;
    this.A=0; this.X=0; this.Y=0; this.S=0xFD; this.P=0x24; this.PC=0x0000;
    this.cy=0; this.pendingNMI=false; this.pendingIRQ=false;
    this.resetVector = 0xFFFC;
    this.op = this.buildOpcodeTable();
  }

  read(a){ return this.bus.read(a); }
  write(a,v){ this.bus.write(a, v & 0xFF); }

  reset() {
    const lo=this.read(this.resetVector), hi=this.read(this.resetVector+1);
    this.PC = (hi<<8)|lo; this.S=0xFD; this.P=0x24; this.cy=0;
    this.pendingIRQ=false; this.pendingNMI=false;
  }

  // Flag helpers
  get C(){return this.P&1;} set C(v){this.P = v? (this.P|1):(this.P&~1);}
  get Z(){return (this.P>>1)&1;} set Z(v){this.P = v? (this.P|2):(this.P&~2);}
  get I(){return (this.P>>2)&1;} set I(v){this.P = v? (this.P|4):(this.P&~4);}
  get D(){return (this.P>>3)&1;} set D(v){this.P = v? (this.P|8):(this.P&~8);}
  get B(){return (this.P>>4)&1;} set B(v){this.P = v? (this.P|16):(this.P&~16);}
  get V(){return (this.P>>6)&1;} set V(v){this.P = v? (this.P|64):(this.P&~64);}
  get N(){return (this.P>>7)&1;} set N(v){this.P = v? (this.P|128):(this.P&~128);}

  fetch(){ const v=this.read(this.PC); this.PC=(this.PC+1)&0xFFFF; return v; }
  push(v){ this.write(0x100|this.S, v); this.S=(this.S-1)&0xFF; }
  pop(){ this.S=(this.S+1)&0xFF; return this.read(0x100|this.S); }

  // Addressing modes return {addr, val, pageCross}
  imm(){ return { val:this.fetch() }; }
  zp(){ const a=this.fetch(); return { addr:a, val:this.read(a) }; }
  zpx(){ const a=(this.fetch()+this.X)&0xFF; return { addr:a, val:this.read(a) }; }
  zpy(){ const a=(this.fetch()+this.Y)&0xFF; return { addr:a, val:this.read(a) }; }
  abs(){ const lo=this.fetch(), hi=this.fetch(); const a=(hi<<8)|lo; return { addr:a, val:this.read(a) }; }
  abx(rmw=false){ const lo=this.fetch(), hi=this.fetch(); const base=(hi<<8)|lo; const a=(base+this.X)&0xFFFF;
    const pageCross=((base&0xFF00)!==(a&0xFF00)); return { addr:a, val:this.read(a), pageCross:(!rmw && pageCross) };
  }
  aby(rmw=false){ const lo=this.fetch(), hi=this.fetch(); const base=(hi<<8)|lo; const a=(base+this.Y)&0xFFFF;
    const pageCross=((base&0xFF00)!==(a&0xFF00)); return { addr:a, val:this.read(a), pageCross:(!rmw && pageCross) };
  }
  idx(){ const zp=(this.fetch()+this.X)&0xFF; const a=(this.read(zp)| (this.read((zp+1)&0xFF)<<8)); return { addr:a, val:this.read(a) }; }
  idy(rmw=false){ const zp=this.fetch(); const base=(this.read(zp)| (this.read((zp+1)&0xFF)<<8)); const a=(base+this.Y)&0xFFFF;
    const pageCross=((base&0xFF00)!==(a&0xFF00)); return { addr:a, val:this.read(a), pageCross:(!rmw && pageCross) };
  }
  indJMP(){ // 6502 bug: if lo byte is 0xFF, high byte does not carry
    const lo=this.fetch(), hi=this.fetch(); const ptr=(hi<<8)|lo;
    const target = (this.read(ptr) | (this.read((ptr&0xFF00)|((ptr+1)&0xFF))<<8));
    return target;
  }

  // ADC/SBC with BCD
  adc(v){
    if (this.D) {
      // BCD mode
      let lo = (this.A & 0x0F) + (v & 0x0F) + this.C;
      let hi = (this.A >> 4) + (v >> 4);
      if (lo > 9) { lo += 6; hi++; }
      this.setNZ(((hi<<4)|(lo & 0x0F)) & 0xFF);
      const carry = hi > 9;
      if (carry) hi += 6;
      this.C = carry; // V flag behavior in BCD is undefined on some chips; emulate standard: compute from binary add
      const binSum = this.A + v + (this.C?1:0);
      this.V = (~(this.A ^ v) & (this.A ^ binSum) & 0x80) !== 0;
      this.A = ((hi<<4) | (lo & 0x0F)) & 0xFF;
    } else {
      const sum = this.A + v + (this.C?1:0);
      this.V = (~(this.A ^ v) & (this.A ^ sum) & 0x80) !== 0;
      this.C = sum > 0xFF;
      this.A = sum & 0xFF;
      this.setNZ(this.A);
    }
  }
  sbc(v){ this.adc((v ^ 0xFF) & 0xFF); }

  setNZ(v){ this.Z = (v===0); this.N = (v & 0x80)!==0; }

  branch(cond){
    const rel = this.fetch(); let off = rel < 0x80 ? rel : rel - 0x100;
    if (cond) {
      const old = this.PC; this.PC = (this.PC + off) & 0xFFFF; this.cy += 1;
      if ((old & 0xFF00) !== (this.PC & 0xFF00)) this.cy += 1;
    }
  }

  interrupt(vector, setB=false){
    // Push PC and P (with B bit for BRK only)
    const pc = this.PC;
    this.push((pc>>8)&0xFF); this.push(pc&0xFF);
    const p = setB ? (this.P | 0x10) : (this.P & ~0x10);
    this.push(p);
    this.I = 1;
    const lo=this.read(vector), hi=this.read(vector+1);
    this.PC = (hi<<8)|lo;
    this.cy += 7;
  }

  nmi(){ this.pendingNMI = true; }
  irq(){ if (!this.I) this.pendingIRQ = true; }

  step(){
    // pending interrupts
    if (this.pendingNMI) { this.pendingNMI=false; this.interrupt(0xFFFA, false); return; }
    if (this.pendingIRQ) { this.pendingIRQ=false; this.interrupt(0xFFFE, false); return; }

    const opcode = this.fetch();
    const e = this.op[opcode];
    if (!e) throw new Error(`Unimpl opcode ${opcode.toString(16)}`);
    this.cy += e.base;
    e.exec(this);
    if (e.page && this._pageCross) { this.cy += 1; }
    this._pageCross = false;
  }

  // A few helpers applied by exec lambdas
  _withPageCross(flag){ this._pageCross = this._pageCross || flag; }

  buildOpcodeTable(){
    const t = new Array(256);
    const RMW = true;
    const ld = (mode, setter) => (cpu)=>{ const m = cpu[mode](); const v = (m.val ?? cpu.read(m.addr)); setter(cpu, v); if (m.pageCross) cpu._withPageCross(true); };
    const st = (mode, getter) => (cpu)=>{ const m = cpu[mode](); cpu.write(m.addr, getter(cpu)); };
    const alu = (mode, op) => (cpu)=>{ const m=cpu[mode](); const v=(m.val ?? cpu.read(m.addr)); op(cpu, v); if (m.pageCross) cpu._withPageCross(true); };

    const setA = (c,v)=>{ c.A=v; c.setNZ(c.A); };
    const getA = (c)=>c.A;

    // LDA
    t[0xA9] = { base:2, exec: ld('imm', setA) };
    t[0xA5] = { base:3, exec: ld('zp', setA) };
    t[0xB5] = { base:4, exec: ld('zpx', setA) };
    t[0xAD] = { base:4, exec: ld('abs', setA) };
    t[0xBD] = { base:4, exec: ld('abx', setA), page:true };
    t[0xB9] = { base:4, exec: ld('aby', setA), page:true };
    t[0xA1] = { base:6, exec: ld('idx', setA) };
    t[0xB1] = { base:5, exec: ld('idy', setA), page:true };

    // STA
    t[0x85] = { base:3, exec: st('zp', getA) };
    t[0x95] = { base:4, exec: st('zpx', getA) };
    t[0x8D] = { base:4, exec: st('abs', getA) };
    t[0x9D] = { base:5, exec: st('abx', getA) };
    t[0x99] = { base:5, exec: st('aby', getA) };
    t[0x81] = { base:6, exec: st('idx', getA) };
    t[0x91] = { base:6, exec: st('idy', getA) };

    // ADC / SBC
    t[0x69] = { base:2, exec: alu('imm', (c,v)=>c.adc(v)) };
    t[0x65] = { base:3, exec: alu('zp',  (c,v)=>c.adc(v)) };
    t[0x75] = { base:4, exec: alu('zpx', (c,v)=>c.adc(v)) };
    t[0x6D] = { base:4, exec: alu('abs', (c,v)=>c.adc(v)) };
    t[0x7D] = { base:4, exec: alu('abx', (c,v)=>c.adc(v)), page:true };
    t[0x79] = { base:4, exec: alu('aby', (c,v)=>c.adc(v)), page:true };
    t[0x61] = { base:6, exec: alu('idx', (c,v)=>c.adc(v)) };
    t[0x71] = { base:5, exec: alu('idy', (c,v)=>c.adc(v)), page:true };

    t[0xE9] = { base:2, exec: alu('imm', (c,v)=>c.sbc(v)) };
    t[0xE5] = { base:3, exec: alu('zp',  (c,v)=>c.sbc(v)) };
    t[0xF5] = { base:4, exec: alu('zpx', (c,v)=>c.sbc(v)) };
    t[0xED] = { base:4, exec: alu('abs', (c,v)=>c.sbc(v)) };
    t[0xFD] = { base:4, exec: alu('abx', (c,v)=>c.sbc(v)), page:true };
    t[0xF9] = { base:4, exec: alu('aby', (c,v)=>c.sbc(v)), page:true };
    t[0xE1] = { base:6, exec: alu('idx', (c,v)=>c.sbc(v)) };
    t[0xF1] = { base:5, exec: alu('idy', (c,v)=>c.sbc(v)), page:true };

    // JSR/RTS/JMP/BRK/RTI
    t[0x20] = { base:6, exec:(c)=>{ const lo=c.fetch(), hi=c.fetch(); const addr=(hi<<8)|lo; const ret=(c.PC-1)&0xFFFF; c.push((ret>>8)&0xFF); c.push(ret&0xFF); c.PC=addr; } };
    t[0x60] = { base:6, exec:(c)=>{ const lo=c.pop(), hi=c.pop(); c.PC=((hi<<8)|lo)+1; } };
    t[0x4C] = { base:3, exec:(c)=>{ const lo=c.fetch(), hi=c.fetch(); c.PC=(hi<<8)|lo; } };
    t[0x6C] = { base:5, exec:(c)=>{ c.PC = c.indJMP(); } };
    t[0x00] = { base:7, exec:(c)=>{ c.PC=(c.PC+1)&0xFFFF; c.interrupt(0xFFFE, true); } }; // BRK

    // Branches
    t[0x90] = { base:2, exec:(c)=>c.branch(!c.C) }; // BCC
    t[0xB0] = { base:2, exec:(c)=>c.branch(!!c.C) }; // BCS
    t[0xF0] = { base:2, exec:(c)=>c.branch(!!c.Z) }; // BEQ
    t[0x30] = { base:2, exec:(c)=>c.branch(!!c.N) }; // BMI
    t[0xD0] = { base:2, exec:(c)=>c.branch(!c.Z) }; // BNE
    t[0x10] = { base:2, exec:(c)=>c.branch(!c.N) }; // BPL
    t[0x50] = { base:2, exec:(c)=>c.branch(!c.V) }; // BVC
    t[0x70] = { base:2, exec:(c)=>c.branch(!!c.V) }; // BVS

    // フラグ/転送/インクリメント等は省略。テーブルを埋め切る。
    return t;
  }
}
