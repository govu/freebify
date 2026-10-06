const simTokens = (s) => s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
// char bigrams of the concatenated text — covers unsegmented scripts
// (Japanese/Chinese have no spaces → one token per line) and captions
// that merge two lyric rows into one cue
const simBigrams = (s) => {
    const t = simTokens(s).join("");
    const b = new Set();
    if (t.length === 1)
        b.add(t);
    for (let i = 0; i + 1 < t.length; i++)
        b.add(t.slice(i, i + 2));
    return b;
};
const dice = (a, b) => {
    if (!a.size || !b.size)
        return 0;
    let hit = 0;
    for (const x of a)
        if (b.has(x))
            hit++;
    return (2 * hit) / (a.size + b.size);
};
// word-Dice survives ASR mishearings; bigram-Dice survives script and
// granularity differences — take whichever reads the lines as more alike
const lineSim = (a, aBi, b, bBi) => Math.max(dice(a, b), dice(aBi, bBi));
// ASR noise isn't a lyric — "[música]", "[Applause]", ">>" speaker markers —
// strip every bracketed marker from caption-derived text; marker-only cues
// become "" and get dropped
const capText = (t) => t.replace(/\[[^\]]*\]/g, " ").replace(/>+/g, "").replace(/\s+/g, " ").trim();
// A lyric DB's timestamps describe the studio recording; playback is THIS
// upload, whose video intro the record never saw. The video's own caption
// track is timed to our exact audio, so matching the first lyric lines
// against it measures the real lead-in. Captions are ASR-messy — a quorum
// of agreeing deltas is required so one bad match can't beat the duration
// guess it replaces. null = couldn't measure (keep the guess).
const alignOffset = (lrc, caps) => {
    // captions often split one lyric row across two cues — scoring against
    // line+next merged (bounded gap so distant rows can't fake a match)
    // keeps a granularity quirk from costing us a candidate
    const pool = [];
    for (let i = 0; i < caps.length; i++) {
        pool.push({ t: caps[i].t, w: new Set(simTokens(caps[i].text)), bi: simBigrams(caps[i].text) });
        const nx = caps[i + 1];
        if (nx && nx.t - caps[i].t < 4) {
            const text = `${caps[i].text} ${nx.text}`;
            pool.push({ t: caps[i].t, w: new Set(simTokens(text)), bi: simBigrams(text) });
        }
    }
    const cands = [];
    // two guards against hooky songs: a repeated line ("oh-eh" every 30s)
    // can latch onto a LATER chorus and manufacture a huge false offset.
    // (a) monotonic — caption time can only move forward as lyrics advance;
    // (b) plausible window — the match window can't be a constant: cinematic
    //   intros run minutes (MONACO ≈ +170s before the first sung word). The
    //   latest a line can land is bounded by the caption span itself — the
    //   last cue marks the end of the audio.
    const maxOff = Math.max(120, (caps[caps.length - 1]?.t ?? 120) - (lrc[0]?.t ?? 0) - 10);
    // Prefer lines that appear ONCE in the sheet — unique lines can't latch
    // onto a repeated hook's other occurrences at all
    const head = lrc.slice(0, 14);
    const freq = new Map();
    for (const l of head) {
        const k = simTokens(l.text).join(" ");
        freq.set(k, (freq.get(k) ?? 0) + 1);
    }
    const uniq = head.filter((l) => freq.get(simTokens(l.text).join(" ")) === 1);
    const sample = uniq.length >= 3 ? uniq : head;
    // hooks can't vote — "Oh-eh, oh-eh"-type lines (≤3 distinct tokens) latch
    // onto chanted intro cues and measure the intro's own chant, not where the
    // real lyric line lands. Content-rich lines only when enough exist.
    const rich = sample.filter((l) => new Set(simTokens(l.text)).size >= 4);
    const voters = rich.length >= 3 ? rich : sample;
    let lastT = -Infinity;
    for (const l of voters) {
        const w = new Set(simTokens(l.text));
        const bi = simBigrams(l.text);
        let best = 0;
        let bestT = 0;
        for (const c of pool) {
            if (c.t < lastT - 1)
                continue;
            const dt = c.t - l.t;
            if (dt < -45 || dt > maxOff)
                continue;
            const s = lineSim(w, bi, c.w, c.bi);
            if (s > best) {
                best = s;
                bestT = c.t;
            }
        }
        if (best < 0.55)
            continue;
        // argmax picks the CLEANEST occurrence — for a repeated hook that's a
        // later chorus, which poisons the monotonic cursor for every line
        // after it. Any cue within 85% of the top score is an equivalent match;
        // take the EARLIEST of those instead
        let earlyT = bestT;
        for (const c of pool) {
            const dt = c.t - l.t;
            // same monotonic guard as the main scan — an earlier equivalent match
            // that regresses the cursor poisons every voter after it
            if (c.t < lastT - 1 || dt < -45 || dt > maxOff || c.t >= earlyT)
                continue;
            if (lineSim(w, bi, c.w, c.bi) >= best * 0.85)
                earlyT = c.t;
        }
        cands.push(earlyT - l.t);
        lastT = earlyT;
    }
    if (cands.length < 3)
        return null;
    cands.sort((a, b) => a - b);
    // the true offset clusters within a few seconds (ASR cue jitter splits
    // tighter windows); wrong matches scatter
    let bi = 0;
    let bn = 0;
    for (let i = 0, j = 0; i < cands.length; i++) {
        while (j < cands.length && cands[j] - cands[i] <= 4)
            j++;
        if (j - i > bn) {
            bi = i;
            bn = j - i;
        }
    }
    if (bn < Math.max(3, Math.ceil(cands.length * 0.4)))
        return null;
    const off = Math.round(cands[bi + Math.floor(bn / 2)] * 10) / 10;
    // beyond the caption span there is no audio left to shift into — but a
    // multi-minute cinematic intro is a legitimate measured offset
    return off >= -45 && off <= maxOff ? off : null;
};
// One global offset fixes intros but NOT mid-song structural divergence —
// sheets can omit a verse section entirely (Calm Down drops ~15s of verse
// between "chewing gum" and the chorus) or the upload adds/removes one.
// A narrow window around the global guess can never recover those lines.
// Instead each line anchors inside a wide FORWARD-leaning window while a
// running offset tracks the local drift: a dropped section makes the audio
// land later than expected, so we look farther ahead than behind.
// The distance penalty keeps repeated hooks honest — a far cue must be
// clearly more similar to beat a near one. Monotonic by prevT clamp.
// Adopted only with real coverage.
const alignLines = (lrc, caps, off) => {
    const pool = [];
    for (let i = 0; i < caps.length; i++) {
        pool.push({ t: caps[i].t, w: new Set(simTokens(caps[i].text)), bi: simBigrams(caps[i].text) });
        const nx = caps[i + 1];
        if (nx && nx.t - caps[i].t < 4) {
            const text = `${caps[i].text} ${nx.text}`;
            pool.push({ t: caps[i].t, w: new Set(simTokens(text)), bi: simBigrams(text) });
        }
    }
    const out = lrc.map((l) => ({ ...l }));
    let anchored = 0;
    let searchable = 0;
    let prevT = -1e9;
    let prevOrig = 0;
    let runOff = off;
    // a distant anchor is a claim that the structure jumped — a REAL jump
    // (Telephone's +74s dialogue break) keeps holding for the following
    // lines; a repeated hook's later occurrence does not. Before accepting a
    // far anchor we check the next searchable line has SOME match near the
    // implied new offset — otherwise the "anchor" drags the monotonic floor
    // forward and strands every line after it (Calm Down: a chorus text at
    // +82s pulled 20 lines into a wall).
    const confirmedFar = (idx, localOff) => {
        for (let j = idx + 1; j < lrc.length; j++) {
            const w2 = new Set(simTokens(lrc[j].text));
            if (w2.size < 2)
                continue;
            const bi2 = simBigrams(lrc[j].text);
            const exp2 = lrc[j].t + localOff;
            for (const c of pool) {
                if (Math.abs(c.t - exp2) > 12)
                    continue;
                if (lineSim(w2, bi2, c.w, c.bi) >= 0.45)
                    return true;
            }
            return false; // next searchable line has no match near the new offset
        }
        return true; // nothing left to contradict
    };
    for (let li = 0; li < out.length; li++) {
        const l = out[li];
        const orig = l.t;
        const w = new Set(simTokens(l.text));
        if (w.size < 2) {
            l.t = Math.max(orig + runOff, prevT + Math.max(0.05, orig - prevOrig));
            prevT = l.t;
            prevOrig = orig;
            continue;
        }
        searchable++;
        const bi = simBigrams(l.text);
        const exp = orig + runOff;
        let bestT = -1;
        let bestAdj = 0;
        for (const c of pool) {
            // forward-leaning window: a dropped sheet section pushes audio late —
            // videos also INSERT mid-song breaks (Telephone sticks ~74s of dialogue
            // between verses), so the far bound must reach past those; radio-edit
            // uploads CUT sections instead, dragging later lines up to ~40s early.
            // Similarity demand scales with distance: mid-range tolerates noisy
            // ASR, truly far anchors need strong text agreement AND confirmation.
            const lo = Math.max(exp - 40, prevT);
            if (c.t < lo || c.t > exp + 90)
                continue;
            const s = lineSim(w, bi, c.w, c.bi);
            const dist = Math.abs(c.t - exp);
            if (s < (dist > 45 ? 0.68 : dist > 25 ? 0.55 : 0.5))
                continue;
            const adj = s - 0.015 * dist;
            if (adj > bestAdj || bestT < 0) {
                bestAdj = adj;
                bestT = c.t;
            }
        }
        if (bestT >= 0 && Math.abs(bestT - exp) > 30 && !confirmedFar(li, bestT - orig)) {
            bestT = -1; // unconfirmed structural jump — keep natural spacing
        }
        if (bestT >= 0) {
            // local evidence nudges the running offset — clamped per-step so one
            // stray match can't swing the expectation, but a real structural
            // jump is absorbed within a few anchored lines
            const localOff = bestT - orig;
            runOff += Math.max(-15, Math.min(15, localOff - runOff)) * 0.5;
            l.t = bestT;
            anchored++;
        }
        else {
            // keep the line's natural spacing from its predecessor instead of
            // collapsing onto it — unanchored stretches (sparse ASR tails, sheet
            // holes) would otherwise stack a burst of lines at one timestamp
            l.t = Math.max(exp, prevT + Math.max(0.05, orig - prevOrig));
        }
        prevT = l.t;
        prevOrig = orig;
    }
    return anchored >= Math.max(4, Math.ceil(searchable * 0.45)) ? out : null;
};
// A same-title WRONG SONG's sheet can slide past every metadata gate
// (identical runtime, artist word overlap) — alignOffset only judges
// timing, not content. The video's own captions are the ground truth:
// sample ~18 spread lines and ask whether their words appear in them at
// all. A real match hits repeatedly even through ASR noise; a foreign
// sheet barely matches anywhere.
const lrcContentOk = (lrc, caps) => {
    if (caps.length < 12)
        return true; // too sparse to judge — don't veto on nothing
    const pool = caps.map((c) => ({ t: c.t, w: new Set(simTokens(c.text)), bi: simBigrams(c.text) }));
    const maxDt = Math.max(180, (caps[caps.length - 1]?.t ?? 0) - (lrc[0]?.t ?? 0) - 10);
    const step = Math.max(1, Math.floor(lrc.length / 18));
    let hit = 0;
    let n = 0;
    for (let i = 0; i < lrc.length; i += step) {
        const l = lrc[i];
        const w = new Set(simTokens(l.text));
        const bi = simBigrams(l.text);
        let best = 0;
        for (const c of pool) {
            // same bound as alignOffset: cinematic intros run minutes, so the
            // sheet's real words can sit hundreds of seconds ahead of their
            // canonical time — a fixed +180 vetoes CORRECT sheets on long-intro
            // uploads and swaps them for raw caption text
            const dt = c.t - l.t;
            if (dt < -120 || dt > maxDt)
                continue;
            const s = lineSim(w, bi, c.w, c.bi);
            if (s > best)
                best = s;
        }
        n++;
        if (best >= 0.45)
            hit++;
    }
    return n === 0 || hit / n >= 0.34;
};
// post-measure sanity: with the shift applied, sampled lines should land
// near their own caption match. But ASR/manually-captioned tracks go sparse
// or idiosyncratic mid-song (pidgin spellings, merged cues, "♪" markers) —
// requiring EVERY line to match nearby false-vetoes correct measurements.
// A line only counts AGAINST the offset when it strongly matches a cue FAR
// from its expected position — a real contradiction. Weak/absent matches
// abstain; they're noise, not evidence.
const timingOk = (lrc, caps, off) => {
    if (caps.length < 8)
        return true; // too sparse to verify — trust the quorum
    const pool = caps.map((c) => ({ t: c.t, w: new Set(simTokens(c.text)), bi: simBigrams(c.text) }));
    const step = Math.max(1, Math.floor(lrc.length / 14));
    let hit = 0;
    let miss = 0;
    for (let i = 0; i < lrc.length; i += step) {
        const w = new Set(simTokens(lrc[i].text));
        const bi = simBigrams(lrc[i].text);
        let near = 0;
        let far = 0;
        for (const c of pool) {
            const s = lineSim(w, bi, c.w, c.bi);
            if (Math.abs(c.t - (lrc[i].t + off)) <= 7) {
                if (s > near)
                    near = s;
            }
            else if (s > far)
                far = s;
        }
        if (near >= 0.45)
            hit++;
        else if (far >= 0.62)
            miss++;
    }
    const votes = hit + miss;
    return votes < 4 || hit / votes >= 0.5;
};
// display-only "♪" markers inside real sung gaps: a sheet that omits a
// section (Calm Down drops a ~15s verse) otherwise leaves its previous line
// lit through music it has no words for — the marker shows the song still
// moves. Only where a caption carries actual words; instrumental breaks
// stay empty. Never persisted — aligned times stay sheet-length for lrcaln.
export { simTokens, simBigrams, dice, lineSim, capText, alignOffset, alignLines, lrcContentOk, timingOk };
