// keyboard.js
export class Keyboard {
  constructor() {
    this.matrix = Array.from({length:10},()=>0xFF); // 1=not pressed
    this.rowSel = 0xFF;
    this.map = this.buildKeymap();
    window.addEventListener('keydown', e=>this.setKey(e, true));
    window.addEventListener('keyup', e=>this.setKey(e, false));
  }
  buildKeymap(){
    // 例: { 'A': {row:1, col:0}, ... } PET 配列に合わせて定義
    return {
      'A': {r:1,c:0}, 'B':{r:2,c:3}, 'RETURN':{r:0,c:7}, // etc.
    };
  }
  setKey(e, down){
    const code = (e.key.length===1 ? e.key.toUpperCase() : e.key.toUpperCase());
    const m = this.map[code]; if (!m) return;
    const mask = ~(1<<m.c) & 0xFF;
    if (down) this.matrix[m.r] &= mask; else this.matrix[m.r] |= (~mask)&0xFF;
    e.preventDefault();
  }
  hook(bus, selAddr, readAddr){
    bus.hookIO(selAddr, selAddr, (a)=>{}, (a,v)=>{ this.rowSel=v&0xFF; });
    bus.hookIO(readAddr, readAddr, (a)=>{ // 読み
      let v = 0xFF;
      for (let r=0; r<this.matrix.length; r++){
        // 選択された行だけ有効にする（実機ロジックに合わせて調整）
        if (((this.rowSel>>r)&1)===0) v &= this.matrix[r];
      }
      return v;
    }, (a,v)=>{});
  }
}
