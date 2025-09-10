// via6522.js (最小)
export class VIA6522 {
  constructor(cpu){
    this.cpu=cpu;
    this.reg = new Uint8Array(16);
    this.timer1 = 0; this.t1Latch=0; this.t1Enabled=false;
  }
  hook(bus, base){
    bus.hookIO(base, base+0x0F,
      (addr)=>{ const i=addr&0x0F; return this.reg[i]; },
      (addr,val)=>{ const i=addr&0x0F; this.writeReg(i, val); }
    );
  }
  writeReg(i, v){
    this.reg[i]=v&0xFF;
    if (i===4){ // T1C-L
      this.t1Latch = (this.t1Latch & 0xFF00) | v;
    } else if (i===5){ // T1C-H -> load and start
      this.t1Latch = ((v<<8) | (this.t1Latch&0xFF)) & 0xFFFF;
      this.timer1 = this.t1Latch; this.t1Enabled = true;
    }
  }
  tick(cycles){
    if (this.t1Enabled){
      this.timer1 -= cycles;
      if (this.timer1 <= 0){
        this.timer1 += this.t1Latch || 0x10000;
        // IRQ 発火（IFR/IER を簡易化）
        this.cpu.irq();
      }
    }
  }
}
