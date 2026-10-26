// A short chime made on the spot, so no sound file is needed. Browsers only play it once the screen has been
// tapped since the page opened.
export function chime(notes = [880, 1175]) {
  try {
    const c = new AudioContext();
    notes.forEach((hz, i) => {
      const o = c.createOscillator(), g = c.createGain(), at = c.currentTime + i * .18;
      o.frequency.value = hz;
      g.gain.setValueAtTime(.0001, at);
      g.gain.exponentialRampToValueAtTime(.25, at + .02);
      g.gain.exponentialRampToValueAtTime(.0001, at + .35);
      o.connect(g).connect(c.destination);
      o.start(at); o.stop(at + .4);
    });
  } catch {}
}
