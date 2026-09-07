/**
 * 文献ベースの基準角度と、身長・体重からの体格補正モデル。
 *
 * 【重要な但し書き】
 * 「身長・体重を入れると理想の関節角度が出る」検証済みの回帰式は文献に存在しない。
 * ここでは出所を3層に分け、UIでも必ずラベル表示する。
 *   L1 文献値      … 査読論文・学位論文の mean ± SD をそのまま使う
 *   L2 文献の関係式 … 論文が示した関係（例: バットスピード↔最適アタックアングル）を内挿
 *   L3 ヒューリスティック … 体格からの補正。検証されていない当アプリ独自の推定
 */

export const LEVEL = { L1: '文献値', L2: '文献の関係式', L3: '体格補正(推定)' };

export const CITATIONS = {
  fortenbaugh2011: {
    key: 'Fortenbaugh 2011',
    text: 'Fortenbaugh, D. M. (2011). The Biomechanics of the Baseball Swing. 博士論文, University of Miami (Open Access Dissertations, Paper 540).',
    url: 'https://scholarship.miami.edu/esploro/outputs/doctoral/The-Biomechanics-of-the-Baseball-Swing/991031447629302976',
    note: 'Table 1「Mean ± SD of kinematic angles at BC」の MIDDLE（真ん中のコース）列を採用。原典は屈曲角(0°=完全伸展)表記のため、本アプリの内角表記へ 180−x で変換している。',
  },
  fleisig: {
    key: 'Fleisig et al.',
    text: 'Fleisig, G. S. ら による投球バイオメカニクスの基準値（大学〜プロ投手）。ASMI の一連の研究およびレビューによる。',
    url: 'https://pubmed.ncbi.nlm.nih.gov/36413165/',
    note: '踏込脚膝屈曲 38±9°(足接地)、リリース時肘屈曲 29±6°、肩外転 約90° など。',
  },
  nathan: {
    key: 'Nathan / ABCA',
    text: 'Alan M. Nathan の "Optimizing the Swing" と ABCA Inside Pitch (2019) "In Pursuit of the Optimal Swing"。',
    url: 'https://www.abca.org/magazine/magazine/2019-3-May_June/The_Hot_Corner_In_Pursuit_of_the_Optimal_Swing.aspx',
    note: '速球の入射角 約-6°、変化球 約-10°。最適アタックアングルは概ね +2〜+14°で、バットスピードが遅いほど大きい(遅い場合 約21°)。',
  },
  winter: {
    key: 'Winter / De Leva',
    text: 'Winter, D. A. "Biomechanics and Motor Control of Human Movement"／De Leva (1996) の人体計測（体節長の身長比）。',
    url: 'https://pubmed.ncbi.nlm.nih.gov/8872282/',
    note: '身長から体節長を推定する比率。体格補正の土台に使用。',
  },
};

/* ------------------------------------------------------------------ *
 * L1: 文献の基準角度
 * ------------------------------------------------------------------ */

/**
 * 各エントリ:
 *  metric   … metrics.js の id（打席/投球の左右で lead/trail を解決する）
 *  event    … 比較するイベント（'contact' 接触 / 'foot_contact' 踏込足接地 / 'release' リリース）
 *  mean,sd  … 本アプリの角度表記に変換済みの値（度）
 *  level    … LEVEL のいずれか
 *  raw      … 原典での表記（変換前）
 *  needsCalib … true の場合、回旋系なので「基準姿勢セット」が必要
 */
const SWING = (lead, trail) => ([
  { metric: `knee_${lead}`, event: 'contact', mean: 162, sd: 4, level: LEVEL.L1, cite: 'fortenbaugh2011',
    label: '踏込脚 膝角度', raw: '原典: 屈曲 18 ± 4°（0°=伸展）' },
  { metric: `elbow_${trail}`, event: 'contact', mean: 99, sd: 8, level: LEVEL.L1, cite: 'fortenbaugh2011',
    label: '後ろ肘 角度', raw: '原典: 屈曲 81 ± 8°' },
  { metric: `shoulder_elev_${lead}`, event: 'contact', mean: 70, sd: 4, level: LEVEL.L1, cite: 'fortenbaugh2011',
    label: '前肩 挙上角', raw: '原典: Lead Shoulder Elevation 70 ± 4°',
    caution: '原典は球面座標(elevation/azimuth)による定義。本アプリの体幹軸基準の挙上角とは定義が完全一致しないため、傾向の比較にとどめること。' },
  { metric: 'pelvis_rot', event: 'contact', mean: 77, sd: 6, level: LEVEL.L1, cite: 'fortenbaugh2011',
    label: '骨盤 回旋角', raw: '原典: Pelvis Rotation 77 ± 6°（0°=本塁方向, 90°=投手方向）', needsCalib: true },
  { metric: 'x_factor', event: 'contact', mean: -2, sd: 4, level: LEVEL.L1, cite: 'fortenbaugh2011',
    label: '捻転差 (肩−骨盤)', raw: '原典: Upper Trunk Rotation w.r.t. Pelvis −2 ± 4°', needsCalib: true,
    caution: '接触時点では上半身が骨盤に追いつくため、ほぼ0付近になるのが正常。捻転差の最大値はテイクバック〜ステップ中に現れる。' },
  { metric: 'head_tilt', event: 'contact', mean: 47, sd: 5, level: LEVEL.L1, cite: 'fortenbaugh2011',
    label: '頭部 回旋', raw: '原典: Head Rotation 47 ± 5°',
    caution: '原典は頭部の「回旋」。本アプリの head_tilt は体幹軸に対する頭の傾きであり別物。参考値として表示。' },
]);

const PITCH = (lead, trail) => ([
  { metric: `knee_${lead}`, event: 'foot_contact', mean: 142, sd: 9, level: LEVEL.L1, cite: 'fleisig',
    label: '踏込脚 膝角度（足接地）', raw: '原典: 屈曲 38 ± 9°' },
  { metric: `elbow_${trail}`, event: 'release', mean: 151, sd: 6, level: LEVEL.L1, cite: 'fleisig',
    label: '投球肘 角度（リリース）', raw: '原典: 屈曲 29 ± 6°' },
  { metric: `shoulder_elev_${trail}`, event: 'release', mean: 90, sd: 10, level: LEVEL.L1, cite: 'fleisig',
    label: '投球肩 挙上角', raw: '原典: 肩外転 約90°' },
  { metric: 'pelvis_rot', event: 'foot_contact', mean: 35, sd: 12, level: LEVEL.L1, cite: 'fleisig',
    label: '骨盤 回旋角（足接地）', raw: '原典: 足接地時に骨盤は約35°ターゲット方向へ回旋', needsCalib: true },
]);

export const REFERENCE_SETS = {
  bat_R: { label: 'バッティング（右打ち）', kind: 'bat', lead: 'L', trail: 'R', refs: SWING('L', 'R') },
  bat_L: { label: 'バッティング（左打ち）', kind: 'bat', lead: 'R', trail: 'L', refs: SWING('R', 'L') },
  pitch_R: { label: 'ピッチング（右投げ）', kind: 'pitch', lead: 'L', trail: 'R', refs: PITCH('L', 'R') },
  pitch_L: { label: 'ピッチング（左投げ）', kind: 'pitch', lead: 'R', trail: 'L', refs: PITCH('R', 'L') },
};

/* ------------------------------------------------------------------ *
 * L3: 人体計測（身長から体節長）
 * ------------------------------------------------------------------ */

// Winter の体節長／身長 比
const SEGMENT_RATIO = {
  upperArm: 0.186, forearm: 0.146, hand: 0.108,
  thigh: 0.245, shank: 0.246, foot: 0.152,
  trunk: 0.288, shoulderWidth: 0.259, hipWidth: 0.191,
};

export function anthropometry(heightCm, massKg) {
  const h = heightCm / 100;
  const seg = {};
  for (const [k, r] of Object.entries(SEGMENT_RATIO)) seg[k] = +(h * r * 100).toFixed(1); // cm
  const bmi = massKg / (h * h);
  return { heightCm, massKg, bmi: +bmi.toFixed(1), segments: seg,
           // 肩からグリップまでの回転半径の目安（バット長は含まない）
           armRadiusCm: +(seg.upperArm + seg.forearm + seg.hand * 0.5).toFixed(1) };
}

/** 一般的なバット選びの目安（身長・体重ベースのフィッティング表の考え方） */
export function batRecommendation(heightCm, massKg) {
  // 一般的なバットフィッティング表（身長ベース）に近い係数
  const lengthIn = Math.round((heightCm / 2.54) * 0.42 + 4.2);
  const lengthCm = Math.round(lengthIn * 2.54);
  const weightG = Math.round(700 + (massKg - 60) * 2.2 + (heightCm - 170) * 1.5);
  return { lengthIn, lengthCm, weightG: Math.max(600, Math.min(1000, weightG)) };
}

/* ------------------------------------------------------------------ *
 * L2 + L3: 目標アタックアングル
 * ------------------------------------------------------------------ */

/** 競技レベル別のバットスピード目安（mph）。実測値があれば必ずそちらを使うこと。 */
export const BAT_SPEED_BY_LEVEL = {
  elementary: { label: '小学生', mph: 45, medianH: 145, medianM: 38 },
  junior:     { label: '中学生', mph: 55, medianH: 163, medianM: 52 },
  high:       { label: '高校生', mph: 64, medianH: 172, medianM: 66 },
  college:    { label: '大学・社会人', mph: 69, medianH: 175, medianM: 76 },
  pro:        { label: 'プロ', mph: 72, medianH: 183, medianM: 90 },
};

/** 投球種別ごとの入射角（度、負=下向き） */
export const PITCH_DESCENT = {
  fastball: { label: 'ストレート', deg: -6 },
  offspeed: { label: '変化球', deg: -10 },
};

/**
 * バットスピードの推定。
 * レベル別の目安（目安値）に、身長・体重の中央値からのズレで補正をかける（L3ヒューリスティック）。
 */
export function estimateBatSpeed(levelKey, heightCm, massKg, measuredMph) {
  if (measuredMph) return { mph: measuredMph, level: '実測値', detail: '入力された実測バットスピードを使用。' };
  const L = BAT_SPEED_BY_LEVEL[levelKey] || BAT_SPEED_BY_LEVEL.high;
  const dH = (heightCm ?? L.medianH) - L.medianH;
  const dM = (massKg ?? L.medianM) - L.medianM;
  const adj = 0.10 * dH + 0.10 * dM; // 検証されていない補正係数
  const mph = Math.max(35, Math.min(85, L.mph + adj));
  return {
    mph: +mph.toFixed(1),
    level: LEVEL.L3,
    detail: `${L.label}の目安 ${L.mph} mph に、身長 ${dH >= 0 ? '+' : ''}${dH.toFixed(0)}cm・体重 ${dM >= 0 ? '+' : ''}${dM.toFixed(0)}kg 分の補正 ${adj >= 0 ? '+' : ''}${adj.toFixed(1)} mph を加算。補正係数(0.10)は当アプリの推定であり検証されていない。`,
  };
}

/**
 * 目標アタックアングル。
 * Nathan/ABCA の2点（遅いバットスピードで約21°、最適帯は+2〜+14°）を線形内挿する。
 */
export function idealAttackAngle({ levelKey, heightCm, massKg, measuredMph, pitchType = 'fastball' }) {
  const bs = estimateBatSpeed(levelKey, heightCm, massKg, measuredMph);
  const distanceOptimal = Math.max(2, Math.min(21, 21 - 0.371 * (bs.mph - 45)));
  const descent = PITCH_DESCENT[pitchType]?.deg ?? -6;
  const matchOptimal = Math.abs(descent); // 入射角に合わせる案（タイミング誤差に強い）
  return {
    batSpeed: bs,
    descentDeg: descent,
    // 飛距離重視の目標
    distance: { target: +distanceOptimal.toFixed(1), lo: +(distanceOptimal - 5).toFixed(1), hi: +(distanceOptimal + 5).toFixed(1), level: LEVEL.L2 },
    // 当てやすさ重視の目標（入射角マッチ）
    contact: { target: +matchOptimal.toFixed(1), lo: +(matchOptimal - 4).toFixed(1), hi: +(matchOptimal + 4).toFixed(1), level: LEVEL.L2 },
    // 総合帯（文献が示す一般的な最適帯）
    generalBand: { lo: 2, hi: 14, level: LEVEL.L1 },
    rationale: [
      `バットスピード: ${bs.mph} mph（${bs.level}）`,
      `${PITCH_DESCENT[pitchType]?.label ?? ''}の入射角: ${descent}°`,
      `飛距離重視: 21° − 0.371 × (${bs.mph} − 45) = ${distanceOptimal.toFixed(1)}°（Nathan/ABCA の2点を内挿）`,
      `当てやすさ重視: 入射角に一致させる = ${matchOptimal}°`,
    ],
  };
}

/** 実測値と基準の比較結果 */
export function compare(actual, mean, sd) {
  if (actual == null || !Number.isFinite(actual)) return null;
  const diff = actual - mean;
  const z = sd > 0 ? diff / sd : 0;
  let verdict;
  if (Math.abs(z) <= 1) verdict = { key: 'in', label: '基準内', tone: 'good' };
  else if (Math.abs(z) <= 2) verdict = { key: 'edge', label: 'やや外れ', tone: 'warn' };
  else verdict = { key: 'out', label: '大きく外れ', tone: 'bad' };
  return { actual: +actual.toFixed(1), mean, sd, diff: +diff.toFixed(1), z: +z.toFixed(2), verdict };
}
