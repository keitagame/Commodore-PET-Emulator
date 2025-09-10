// init.js
import {Bus} from './bus.js';
import {CPU6502} from './cpu6502.js';
import {TextVideo} from './video.js';
import {VIA6522} from './via6522.js';

async function loadROM(url){ const b=await fetch(url).then(r=>r.arrayBuffer()); return new Uint8Array(b); }

export async function boot(canvas){
  const bus = new Bus();
  // map ROMs (例: アドレスは機種に合わせて調整)
  bus.mapROM(0xF000, await loadROM('basic.rom'));
  bus.mapROM(0xE000, await loadROM('editor.rom'));
  bus.mapROM(0xF800, await loadROM('kernal.rom'));
  const charROM = await loadROM('char.rom');

  const video = new TextVideo(canvas, 40, 25, 0x8000, charROM);
  video.hook(bus);

  const cpu = new CPU6502(bus);
  const via = new VIA6522(cpu);
  via.hook(bus, 0xE840); // 仮：モデルにより異なる

  cpu.reset();

  // スケジューラ：CPUを一定サイクル回し、VIA/描画を更新
  const CLOCK = 1_000_000; // 1MHz
  const FRAME = 60;
  const CYCLES_PER_FRAME = Math.floor(CLOCK/FRAME);

  function frame(){
    let startCy = cpu.cy;
    while ((cpu.cy - startCy) < CYCLES_PER_FRAME){
      const before = cpu.cy;
      cpu.step();
      const delta = cpu.cy - before;
      via.tick(delta);
    }
    video.render(bus);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
