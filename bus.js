// bus.js
export class Bus {
  constructor() {
    this.ram = new Uint8Array(0x10000);
    this.roms = new Map(); // {start, end} -> Uint8Array
    this.ioRead = []; this.ioWrite = [];
  }
  mapROM(start, bytes){ this.roms.set([start, start+bytes.length-1], bytes); }
  hookIO(start, end, readFn, writeFn){ this.ioRead.push([start,end,readFn]); this.ioWrite.push([start,end,writeFn]); }

  read(addr){
    // IO
    for (const [s,e,fn] of this.ioRead) if (addr>=s && addr<=e) { const v=fn(addr); if (v!=null) return v; }
    // ROM
    for (const [[s,e], rom] of this.roms) if (addr>=s && addr<=e) return rom[addr - s];
    // RAM
    return this.ram[addr];
  }
  write(addr, val){
    // IO
    for (const [s,e,fn] of this.ioWrite) if (addr>=s && addr<=e) { fn(addr, val & 0xFF); return; }
    // ROM は書けない
    if (![...this.roms.keys()].some(([s,e])=>addr>=s && addr<=e)) {
      this.ram[addr] = val & 0xFF;
    }
  }
}
