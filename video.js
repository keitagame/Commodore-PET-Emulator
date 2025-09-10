// video.js
export class TextVideo {
  constructor(canvas, cols=40, rows=25, base=0x8000, charROM) {
    this.cols=cols; this.rows=rows; this.base=base; this.charROM=charROM; // Uint8Array(256*8)
    this.canvas=canvas; this.ctx=canvas.getContext('2d');
    this.charW=8; this.charH=8;
    this.scale = Math.floor(Math.min(canvas.width/(cols*8), canvas.height/(rows*8)));
    this.back=0x000000; this.fore=0x00FF00;
    this.invalid = new Set();
  }
  hook(bus){
    bus.hookIO(this.base, this.base+this.cols*this.rows-1,
      (addr)=>{ /* read mirrors RAM; no special read */ },
      (addr,val)=>{ bus.ram[addr]=val; this.invalid.add(addr); }
    );
  }
  render(bus){
    const ctx=this.ctx; ctx.imageSmoothingEnabled=false;
    for (const addr of this.invalid) {
      const off = addr - this.base; if (off<0 || off>=this.cols*this.rows) continue;
      const ch = bus.ram[addr] & 0xFF;
      const cx = (off % this.cols), cy = Math.floor(off / this.cols);
      this.drawChar(cx, cy, ch);
    }
    this.invalid.clear();
  }
  drawChar(cx, cy, code){
    const x0 = cx*this.charW*this.scale, y0 = cy*this.charH*this.scale;
    const glyphOff = code*8;
    for (let row=0; row<8; row++){
      const bits = this.charROM[glyphOff+row];
      for (let col=0; col<8; col++){
        const on = (bits >> (7-col)) & 1;
        this.ctx.fillStyle = on ? '#0f0' : '#000';
        this.ctx.fillRect(x0+col*this.scale, y0+row*this.scale, this.scale, this.scale);
      }
    }
  }
}
