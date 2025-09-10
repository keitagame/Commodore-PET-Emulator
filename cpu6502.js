// cpu6502.js
// MOS 6502 CPU emulator core (official opcodes only), ES module export.

export class CPU6502 {
  constructor(bus) {
    this.bus = bus;

    // Registers
    this.A = 0; this.X = 0; this.Y = 0;
    this.S = 0xFD; // Stack pointer
    this.P = 0x24; // NV-BDIZC (bit 5 unused set)
    this.PC = 0x0000;

    // Timing and interrupts
    this.cy = 0;
    this.pendingNMI = false;
    this.pendingIRQ = false;

    // Internal
    this._pageCross = false;

    // Build opcode table
    this.op = this._buildOpcodeTable();
  }

  // ===== Memory helpers =====
  read(addr) { return this.bus.read(addr) & 0xFF; }
  write(addr, val) { this.bus.write(addr, val & 0xFF); }

  // ===== Flags =====
  get C(){return this.P & 0x01;} set C(v){ this.P = v ? (this.P|0x01) : (this.P & ~0x01); }
  get Z(){return (this.P>>1)&1;} set Z(v){ this.P = v ? (this.P|0x02) : (this.P & ~0x02); }
  get I(){return (this.P>>2)&1;} set I(v){ this.P = v ? (this.P|0x04) : (this.P & ~0x04); }
  get D(){return (this.P>>3)&1;} set D(v){ this.P = v ? (this.P|0x08) : (this.P & ~0x08); }
  get B(){return (this.P>>4)&1;} set B(v){ this.P = v ? (this.P|0x10) : (this.P & ~0x10); }
  // bit 5 unused, stays set
  get V(){return (this.P>>6)&1;} set V(v){ this.P = v ? (this.P|0x40) : (this.P & ~0x40); }
  get N(){return (this.P>>7)&1;} set N(v){ this.P = v ? (this.P|0x80) : (this.P & ~0x80); }

  setNZ(v){ v &= 0xFF; this.Z = (v===0); this.N = (v & 0x80) !== 0; }

  // ===== Stack =====
  push(v){ this.write(0x100 | this.S, v & 0xFF); this.S = (this.S - 1) & 0xFF; }
  pop(){ this.S = (this.S + 1) & 0xFF; return this.read(0x100 | this.S); }

  // ===== Fetch =====
  fetch(){ const v = this.read(this.PC); this.PC = (this.PC + 1) & 0xFFFF; return v; }

  // ===== Addressing modes =====
  imm(){ return { val: this.fetch() }; }
  zp(){ const a = this.fetch(); return { addr: a, val: this.read(a) }; }
  zpx(){ const a = (this.fetch() + this.X) & 0xFF; return { addr: a, val: this.read(a) }; }
  zpy(){ const a = (this.fetch() + this.Y) & 0xFF; return { addr: a, val: this.read(a) }; }
  abs(){ const lo = this.fetch(), hi = this.fetch(); const a = (hi<<8)|lo; return { addr: a, val: this.read(a) }; }
  abx(rmw=false){
    const lo = this.fetch(), hi = this.fetch(); const base = (hi<<8)|lo;
    const a = (base + this.X) & 0xFFFF; const cross = (base & 0xFF00) !== (a & 0xFF00);
    return { addr: a, val: this.read(a), pageCross: (!rmw && cross) };
  }
  aby(rmw=false){
    const lo = this.fetch(), hi = this.fetch(); const base = (hi<<8)|lo;
    const a = (base + this.Y) & 0xFFFF; const cross = (base & 0xFF00) !== (a & 0xFF00);
    return { addr: a, val: this.read(a), pageCross: (!rmw && cross) };
  }
  idx(){ // (zp,X)
    const zp = (this.fetch() + this.X) & 0xFF;
    const a = this.read(zp) | (this.read((zp+1)&0xFF) << 8);
    return { addr: a, val: this.read(a) };
  }
  idy(rmw=false){ // (zp),Y
    const zp = this.fetch();
    const base = this.read(zp) | (this.read((zp+1)&0xFF) << 8);
    const a = (base + this.Y) & 0xFFFF; const cross = (base & 0xFF00) !== (a & 0xFF00);
    return { addr: a, val: this.read(a), pageCross: (!rmw && cross) };
  }
  indJMP(){ // JMP (abs) with 6502 wraparound bug
    const lo = this.fetch(), hi = this.fetch(); const ptr = (hi<<8)|lo;
    const tlo = this.read(ptr);
    const thi = this.read((ptr & 0xFF00) | ((ptr + 1) & 0xFF));
    return (thi<<8) | tlo;
  }

  // ===== ALU (NMOS 6502 behavior) =====
  adc(v){
    v &= 0xFF;
    if (this.D) {
      const a = this.A;
      let lo = (a & 0x0F) + (v & 0x0F) + (this.C ? 1 : 0);
      let hi = (a >> 4) + (v >> 4);
      if (lo > 9) { lo += 6; hi++; }
      const bin = a + v + (this.C ? 1 : 0);
      this.V = (~(a ^ v) & (a ^ bin) & 0x80) !== 0;
      this.C = hi > 9;
      if (hi > 9) hi += 6;
      const res = ((hi << 4) | (lo & 0x0F)) & 0xFF;
      this.A = res; this.setNZ(this.A);
    } else {
      const sum = this.A + v + (this.C ? 1 : 0);
      this.V = (~(this.A ^ v) & (this.A ^ sum) & 0x80) !== 0;
      this.C = sum > 0xFF;
      this.A = sum & 0xFF; this.setNZ(this.A);
    }
  }
  sbc(v){ this.adc((v ^ 0xFF) & 0xFF); }

  // Compare helper
  _cmp(reg, v){
    const t = (reg - (v & 0xFF)) & 0x1FF;
    this.C = (t & 0x100) === 0; // borrow not needed
    const res = (reg - (v & 0xFF)) & 0xFF;
    this.setNZ(res);
  }

  // RMW helpers
  _asl(v){ const out = (v << 1) & 0xFF; this.C = (v & 0x80) !== 0; this.setNZ(out); return out; }
  _lsr(v){ const out = (v >> 1) & 0xFF; this.C = (v & 0x01) !== 0; this.setNZ(out); return out; }
  _rol(v){ const c = this.C ? 1 : 0; this.C = (v & 0x80) !== 0; const out = ((v<<1) | c) & 0xFF; this.setNZ(out); return out; }
  _ror(v){ const c = this.C ? 1 : 0; this.C = (v & 0x01) !== 0; const out = ((c<<7) | (v>>1)) & 0xFF; this.setNZ(out); return out; }

  // ===== Branching =====
  branch(cond){
    const rel = this.fetch(); const off = rel < 0x80 ? rel : rel - 0x100;
    if (cond) {
      const old = this.PC;
      this.PC = (this.PC + off) & 0xFFFF;
      this.cy += 1;
      if ((old & 0xFF00) !== (this.PC & 0xFF00)) this.cy += 1;
    }
  }

  // ===== Interrupts =====
  interrupt(vector, setB=false){
    const pc = this.PC;
    this.push((pc>>8)&0xFF);
    this.push(pc & 0xFF);
    let p = this.P | 0x20; // ensure bit5 set
    if (setB) p |= 0x10; else p &= ~0x10;
    this.push(p);
    this.I = 1;
    const lo = this.read(vector), hi = this.read(vector+1);
    this.PC = (hi<<8) | lo;
    this.cy += 7;
  }
  nmi(){ this.pendingNMI = true; }
  irq(){ if (!this.I) this.pendingIRQ = true; }

  // ===== Reset =====
  reset(){
    const lo = this.read(0xFFFC), hi = this.read(0xFFFD);
    this.PC = (hi<<8)|lo;
    this.S = 0xFD; this.P = 0x24; // bit5 set
    this.cy = 0;
    this.pendingIRQ = false; this.pendingNMI = false;
  }

  // ===== Execute one instruction =====
  step(){
    // Interrupts check
    if (this.pendingNMI) { this.pendingNMI = false; this.interrupt(0xFFFA, false); return; }
    if (this.pendingIRQ) { this.pendingIRQ = false; this.interrupt(0xFFFE, false); return; }

    const opcode = this.fetch();
    const e = this.op[opcode];
    if (!e) throw new Error(`Unimplemented opcode $${opcode.toString(16).padStart(2,'0')}`);
    this.cy += e.base;
    e.exec(this);
    if (e.page && this._pageCross) this.cy += 1;
    this._pageCross = false;
  }
  _withPageCross(flag){ this._pageCross = this._pageCross || !!flag; }

  // ===== Opcode table builder =====
  _buildOpcodeTable(){
    const t = new Array(256);

    // Helpers
    const LD = (mode, set)=> cpu => {
      const m = cpu[mode](); const v = (m.val ?? cpu.read(m.addr)) & 0xFF;
      set(cpu, v); if (m.pageCross) cpu._withPageCross(true);
    };
    const ST = (mode, get)=> cpu => {
      const m = cpu[mode](); cpu.write(m.addr, get(cpu) & 0xFF);
    };
    const ALU = (mode, fn)=> cpu => {
      const m = cpu[mode](); const v = (m.val ?? cpu.read(m.addr)) & 0xFF;
      fn(cpu, v); if (m.pageCross) cpu._withPageCross(true);
    };
    const BITMEM = (mode)=> cpu => {
      const m = cpu[mode](); const v = (m.val ?? cpu.read(m.addr)) & 0xFF;
      cpu.Z = ((cpu.A & v) & 0xFF) === 0;
      cpu.V = (v & 0x40) !== 0;
      cpu.N = (v & 0x80) !== 0;
    };
    const CMP = (mode, get)=> cpu => {
      const m = cpu[mode](); const v = (m.val ?? cpu.read(m.addr)) & 0xFF;
      cpu._cmp(get(cpu), v); if (m.pageCross) cpu._withPageCross(true);
    };
    const RMW_MEM = (mode, op)=> cpu => {
      const m = cpu[mode](true); // rmw true: no pageCross extra
      const addr = m.addr; const v = cpu.read(addr);
      const out = op.call(cpu, v & 0xFF);
      cpu.write(addr, out & 0xFF);
    };
    const RMW_ACC = (op)=> cpu => { cpu.A = op.call(cpu, cpu.A & 0xFF) & 0xFF; };

    // Setters/getters
    const setA = (c,v)=>{ c.A = v & 0xFF; c.setNZ(c.A); };
    const setX = (c,v)=>{ c.X = v & 0xFF; c.setNZ(c.X); };
    const setY = (c,v)=>{ c.Y = v & 0xFF; c.setNZ(c.Y); };
    const getA = c=>c.A; const getX=c=>c.X; const getY=c=>c.Y;

    // ----- LDA -----
    t[0xA9]={base:2,exec:LD('imm',setA)};
    t[0xA5]={base:3,exec:LD('zp',setA)};
    t[0xB5]={base:4,exec:LD('zpx',setA)};
    t[0xAD]={base:4,exec:LD('abs',setA)};
    t[0xBD]={base:4,exec:LD('abx',setA),page:true};
    t[0xB9]={base:4,exec:LD('aby',setA),page:true};
    t[0xA1]={base:6,exec:LD('idx',setA)};
    t[0xB1]={base:5,exec:LD('idy',setA),page:true};

    // ----- LDX -----
    t[0xA2]={base:2,exec:LD('imm',setX)};
    t[0xA6]={base:3,exec:LD('zp',setX)};
    t[0xB6]={base:4,exec:LD('zpy',setX)};
    t[0xAE]={base:4,exec:LD('abs',setX)};
    t[0xBE]={base:4,exec:LD('aby',setX),page:true};

    // ----- LDY -----
    t[0xA0]={base:2,exec:LD('imm',setY)};
    t[0xA4]={base:3,exec:LD('zp',setY)};
    t[0xB4]={base:4,exec:LD('zpx',setY)};
    t[0xAC]={base:4,exec:LD('abs',setY)};
    t[0xBC]={base:4,exec:LD('abx',setY),page:true};

    // ----- STA/STX/STY -----
    t[0x85]={base:3,exec:ST('zp',getA)};
    t[0x95]={base:4,exec:ST('zpx',getA)};
    t[0x8D]={base:4,exec:ST('abs',getA)};
    t[0x9D]={base:5,exec:ST('abx',getA)};
    t[0x99]={base:5,exec:ST('aby',getA)};
    t[0x81]={base:6,exec:ST('idx',getA)};
    t[0x91]={base:6,exec:ST('idy',getA)};

    t[0x86]={base:3,exec:ST('zp',getX)};
    t[0x96]={base:4,exec:ST('zpy',getX)};
    t[0x8E]={base:4,exec:ST('abs',getX)};

    t[0x84]={base:3,exec:ST('zp',getY)};
    t[0x94]={base:4,exec:ST('zpx',getY)};
    t[0x8C]={base:4,exec:ST('abs',getY)};

    // ----- ORA/AND/EOR -----
    t[0x09]={base:2,exec:ALU('imm',(c,v)=>{c.A = (c.A|v)&0xFF; c.setNZ(c.A);})};
    t[0x05]={base:3,exec:ALU('zp',(c,v)=>{c.A = (c.A|v)&0xFF; c.setNZ(c.A);})};
    t[0x15]={base:4,exec:ALU('zpx',(c,v)=>{c.A = (c.A|v)&0xFF; c.setNZ(c.A);})};
    t[0x0D]={base:4,exec:ALU('abs',(c,v)=>{c.A = (c.A|v)&0xFF; c.setNZ(c.A);})};
    t[0x1D]={base:4,exec:ALU('abx',(c,v)=>{c.A = (c.A|v)&0xFF; c.setNZ(c.A);}),page:true};
    t[0x19]={base:4,exec:ALU('aby',(c,v)=>{c.A = (c.A|v)&0xFF; c.setNZ(c.A);}),page:true};
    t[0x01]={base:6,exec:ALU('idx',(c,v)=>{c.A = (c.A|v)&0xFF; c.setNZ(c.A);})};
    t[0x11]={base:5,exec:ALU('idy',(c,v)=>{c.A = (c.A|v)&0xFF; c.setNZ(c.A);}),page:true};

    t[0x29]={base:2,exec:ALU('imm',(c,v)=>{c.A = (c.A&v)&0xFF; c.setNZ(c.A);})};
    t[0x25]={base:3,exec:ALU('zp',(c,v)=>{c.A = (c.A&v)&0xFF; c.setNZ(c.A);})};
    t[0x35]={base:4,exec:ALU('zpx',(c,v)=>{c.A = (c.A&v)&0xFF; c.setNZ(c.A);})};
    t[0x2D]={base:4,exec:ALU('abs',(c,v)=>{c.A = (c.A&v)&0xFF; c.setNZ(c.A);})};
    t[0x3D]={base:4,exec:ALU('abx',(c,v)=>{c.A = (c.A&v)&0xFF; c.setNZ(c.A);}),page:true};
    t[0x39]={base:4,exec:ALU('aby',(c,v)=>{c.A = (c.A&v)&0xFF; c.setNZ(c.A);}),page:true};
    t[0x21]={base:6,exec:ALU('idx',(c,v)=>{c.A = (c.A&v)&0xFF; c.setNZ(c.A);})};
    t[0x31]={base:5,exec:ALU('idy',(c,v)=>{c.A = (c.A&v)&0xFF; c.setNZ(c.A);}),page:true};

    t[0x49]={base:2,exec:ALU('imm',(c,v)=>{c.A = (c.A^v)&0xFF; c.setNZ(c.A);})};
    t[0x45]={base:3,exec:ALU('zp',(c,v)=>{c.A = (c.A^v)&0xFF; c.setNZ(c.A);})};
    t[0x55]={base:4,exec:ALU('zpx',(c,v)=>{c.A = (c.A^v)&0xFF; c.setNZ(c.A);})};
    t[0x4D]={base:4,exec:ALU('abs',(c,v)=>{c.A = (c.A^v)&0xFF; c.setNZ(c.A);})};
    t[0x5D]={base:4,exec:ALU('abx',(c,v)=>{c.A = (c.A^v)&0xFF; c.setNZ(c.A);}),page:true};
    t[0x59]={base:4,exec:ALU('aby',(c,v)=>{c.A = (c.A^v)&0xFF; c.setNZ(c.A);}),page:true};
    t[0x41]={base:6,exec:ALU('idx',(c,v)=>{c.A = (c.A^v)&0xFF; c.setNZ(c.A);})};
    t[0x51]={base:5,exec:ALU('idy',(c,v)=>{c.A = (c.A^v)&0xFF; c.setNZ(c.A);}),page:true};

    // ----- ADC/SBC -----
    t[0x69]={base:2,exec:ALU('imm',(c,v)=>c.adc(v))};
    t[0x65]={base:3,exec:ALU('zp',(c,v)=>c.adc(v))};
    t[0x75]={base:4,exec:ALU('zpx',(c,v)=>c.adc(v))};
    t[0x6D]={base:4,exec:ALU('abs',(c,v)=>c.adc(v))};
    t[0x7D]={base:4,exec:ALU('abx',(c,v)=>c.adc(v)),page:true};
    t[0x79]={base:4,exec:ALU('aby',(c,v)=>c.adc(v)),page:true};
    t[0x61]={base:6,exec:ALU('idx',(c,v)=>c.adc(v))};
    t[0x71]={base:5,exec:ALU('idy',(c,v)=>c.adc(v)),page:true};

    t[0xE9]={base:2,exec:ALU('imm',(c,v)=>c.sbc(v))};
    t[0xE5]={base:3,exec:ALU('zp',(c,v)=>c.sbc(v))};
    t[0xF5]={base:4,exec:ALU('zpx',(c,v)=>c.sbc(v))};
    t[0xED]={base:4,exec:ALU('abs',(c,v)=>c.sbc(v))};
    t[0xFD]={base:4,exec:ALU('abx',(c,v)=>c.sbc(v)),page:true};
    t[0xF9]={base:4,exec:ALU('aby',(c,v)=>c.sbc(v)),page:true};
    t[0xE1]={base:6,exec:ALU('idx',(c,v)=>c.sbc(v))};
    t[0xF1]={base:5,exec:ALU('idy',(c,v)=>c.sbc(v)),page:true};

    // ----- INC/DEC (memory) -----
    t[0xE6]={base:5,exec:RMW_MEM('zp',function(v){ v=(v+1)&0xFF; this.setNZ(v); return v; })};
    t[0xF6]={base:6,exec:RMW_MEM('zpx',function(v){ v=(v+1)&0xFF; this.setNZ(v); return v; })};
    t[0xEE]={base:6,exec:RMW_MEM('abs',function(v){ v=(v+1)&0xFF; this.setNZ(v); return v; })};
    t[0xFE]={base:7,exec:RMW_MEM('abx',function(v){ v=(v+1)&0xFF; this.setNZ(v); return v; })};

    t[0xC6]={base:5,exec:RMW_MEM('zp',function(v){ v=(v-1)&0xFF; this.setNZ(v); return v; })};
    t[0xD6]={base:6,exec:RMW_MEM('zpx',function(v){ v=(v-1)&0xFF; this.setNZ(v); return v; })};
    t[0xCE]={base:6,exec:RMW_MEM('abs',function(v){ v=(v-1)&0xFF; this.setNZ(v); return v; })};
    t[0xDE]={base:7,exec:RMW_MEM('abx',function(v){ v=(v-1)&0xFF; this.setNZ(v); return v; })};

    // ----- INX/DEX/INY/DEY -----
    t[0xE8]={base:2,exec:c=>{ c.X=(c.X+1)&0xFF; c.setNZ(c.X); }};
    t[0xCA]={base:2,exec:c=>{ c.X=(c.X-1)&0xFF; c.setNZ(c.X); }};
    t[0xC8]={base:2,exec:c=>{ c.Y=(c.Y+1)&0xFF; c.setNZ(c.Y); }};
    t[0x88]={base:2,exec:c=>{ c.Y=(c.Y-1)&0xFF; c.setNZ(c.Y); }};

    // ----- Shifts/Rol/Ror -----
    t[0x0A]={base:2,exec:RMW_ACC(function(v){ return this._asl(v); })};
    t[0x06]={base:5,exec:RMW_MEM('zp',function(v){ return this._asl(v); })};
    t[0x16]={base:6,exec:RMW_MEM('zpx',function(v){ return this._asl(v); })};
    t[0x0E]={base:6,exec:RMW_MEM('abs',function(v){ return this._asl(v); })};
    t[0x1E]={base:7,exec:RMW_MEM('abx',function(v){ return this._asl(v); })};

    t[0x4A]={base:2,exec:RMW_ACC(function(v){ return this._lsr(v); })};
    t[0x46]={base:5,exec:RMW_MEM('zp',function(v){ return this._lsr(v); })};
    t[0x56]={base:6,exec:RMW_MEM('zpx',function(v){ return this._lsr(v); })};
    t[0x4E]={base:6,exec:RMW_MEM('abs',function(v){ return this._lsr(v); })};
    t[0x5E]={base:7,exec:RMW_MEM('abx',function(v){ return this._lsr(v); })};

    t[0x2A]={base:2,exec:RMW_ACC(function(v){ return this._rol(v); })};
    t[0x26]={base:5,exec:RMW_MEM('zp',function(v){ return this._rol(v); })};
    t[0x36]={base:6,exec:RMW_MEM('zpx',function(v){ return this._rol(v); })};
    t[0x2E]={base:6,exec:RMW_MEM('abs',function(v){ return this._rol(v); })};
    t[0x3E]={base:7,exec:RMW_MEM('abx',function(v){ return this._rol(v); })};

    t[0x6A]={base:2,exec:RMW_ACC(function(v){ return this._ror(v); })};
    t[0x66]={base:5,exec:RMW_MEM('zp',function(v){ return this._ror(v); })};
    t[0x76]={base:6,exec:RMW_MEM('zpx',function(v){ return this._ror(v); })};
    t[0x6E]={base:6,exec:RMW_MEM('abs',function(v){ return this._ror(v); })};
    t[0x7E]={base:7,exec:RMW_MEM('abx',function(v){ return this._ror(v); })};

    // ----- BIT -----
    t[0x24]={base:3,exec:BITMEM('zp')};
    t[0x2C]={base:4,exec:BITMEM('abs')};

    // ----- CMP/CPX/CPY -----
    t[0xC9]={base:2,exec:CMP('imm',c=>c.A)};
    t[0xC5]={base:3,exec:CMP('zp',c=>c.A)};
    t[0xD5]={base:4,exec:CMP('zpx',c=>c.A)};
    t[0xCD]={base:4,exec:CMP('abs',c=>c.A)};
    t[0xDD]={base:4,exec:CMP('abx',c=>c.A),page:true};
    t[0xD9]={base:4,exec:CMP('aby',c=>c.A),page:true};
    t[0xC1]={base:6,exec:CMP('idx',c=>c.A)};
    t[0xD1]={base:5,exec:CMP('idy',c=>c.A),page:true};

    t[0xE0]={base:2,exec:CMP('imm',c=>c.X)};
    t[0xE4]={base:3,exec:CMP('zp',c=>c.X)};
    t[0xEC]={base:4,exec:CMP('abs',c=>c.X)};

    t[0xC0]={base:2,exec:CMP('imm',c=>c.Y)};
    t[0xC4]={base:3,exec:CMP('zp',c=>c.Y)};
    t[0xCC]={base:4,exec:CMP('abs',c=>c.Y)};

    // ----- Transfers -----
    t[0xAA]={base:2,exec:c=>{ c.X = c.A & 0xFF; c.setNZ(c.X); }};  // TAX
    t[0x8A]={base:2,exec:c=>{ c.A = c.X & 0xFF; c.setNZ(c.A); }};  // TXA
    t[0xA8]={base:2,exec:c=>{ c.Y = c.A & 0xFF; c.setNZ(c.Y); }};  // TAY
    t[0x98]={base:2,exec:c=>{ c.A = c.Y & 0xFF; c.setNZ(c.A); }};  // TYA
    t[0xBA]={base:2,exec:c=>{ c.X = c.S & 0xFF; c.setNZ(c.X); }};  // TSX
    t[0x9A]={base:2,exec:c=>{ c.S = c.X & 0xFF; }};                // TXS

    // ----- Stack ops -----
    t[0x48]={base:3,exec:c=>{ c.push(c.A); }};                    // PHA
    t[0x68]={base:4,exec:c=>{ c.A = c.pop(); c.setNZ(c.A); }};    // PLA
    t[0x08]={base:3,exec:c=>{ c.push(c.P | 0x30); }};             // PHP (B=1, bit5=1)
    t[0x28]={base:4,exec:c=>{ c.P = c.pop(); c.P |= 0x20; c.P &= 0xEF | (c.P & 0x10); }}; // PLP (bit5 stays set)

    // ----- Flags -----
    t[0x18]={base:2,exec:c=>{ c.C = 0; }}; // CLC
    t[0x38]={base:2,exec:c=>{ c.C = 1; }}; // SEC
    t[0x58]={base:2,exec:c=>{ c.I = 0; }}; // CLI
    t[0x78]={base:2,exec:c=>{ c.I = 1; }}; // SEI
    t[0xB8]={base:2,exec:c=>{ c.V = 0; }}; // CLV
    t[0xD8]={base:2,exec:c=>{ c.D = 0; }}; // CLD
    t[0xF8]={base:2,exec:c=>{ c.D = 1; }}; // SED

    // ----- Jumps & Subroutines -----
    t[0x4C]={base:3,exec:c=>{ const lo=c.fetch(), hi=c.fetch(); c.PC = (hi<<8)|lo; }}; // JMP abs
    t[0x6C]={base:5,exec:c=>{ c.PC = c.indJMP(); }};                                   // JMP (ind)
    t[0x20]={base:6,exec:c=>{ const lo=c.fetch(), hi=c.fetch(); const addr=(hi<<8)|lo; const ret=(c.PC-1)&0xFFFF; c.push((ret>>8)&0xFF); c.push(ret&0xFF); c.PC=addr; }}; // JSR
    t[0x60]={base:6,exec:c=>{ const lo=c.pop(), hi=c.pop(); c.PC = (((hi<<8)|lo)+1)&0xFFFF; }}; // RTS
    t[0x40]={base:6,exec:c=>{ const p = c.pop(); const lo=c.pop(), hi=c.pop(); c.P = (p|0x20) & 0xEF | (p & 0x10); c.PC = (hi<<8)|lo; }}; // RTI

    // ----- BRK -----
    t[0x00]={base:7,exec:c=>{ c.fetch(); c.interrupt(0xFFFE, true); }}; // BRK (PC already incremented)

    // ----- Branches -----
    t[0x90]={base:2,exec:c=>c.branch(!c.C)}; // BCC
    t[0xB0]={base:2,exec:c=>c.branch(!!c.C)}; // BCS
    t[0xF0]={base:2,exec:c=>c.branch(!!c.Z)}; // BEQ
    t[0x30]={base:2,exec:c=>c.branch(!!c.N)}; // BMI
    t[0xD0]={base:2,exec:c=>c.branch(!c.Z)}; // BNE
    t[0x10]={base:2,exec:c=>c.branch(!c.N)}; // BPL
    t[0x50]={base:2,exec:c=>c.branch(!c.V)}; // BVC
    t[0x70]={base:2,exec:c=>c.branch(!!c.V)}; // BVS

    // ----- NOP -----
    t[0xEA]={base:2,exec:()=>{}}; // NOP

    // Fill undefined official opcodes with NOP to be safe (optional)
    for (let i=0;i<256;i++){
      if (!t[i]) t[i] = { base:2, exec: ()=>{ /* unofficial or undefined -> NOP */ } };
    }
    return t;
  }
}

