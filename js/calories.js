// Daily calorie burn (TDEE) estimate: Mifflin-St Jeor resting rate x activity factor.
// Pure functions; the profile keeps values as typed, in the units the user picked.

export const ACTIVITY = [
  { id: 'sedentary', label: 'Sedentary', note: 'little exercise', factor: 1.2 },
  { id: 'light', label: 'Light', note: '1–3 workouts/wk', factor: 1.375 },
  { id: 'moderate', label: 'Moderate', note: '3–5 workouts/wk', factor: 1.55 },
  { id: 'very', label: 'Very active', note: 'daily hard training', factor: 1.725 },
  { id: 'extra', label: 'Extra active', note: '+ physical job', factor: 1.9 },
];

export const GOALS = [
  { id: 'lose1', label: 'Lose 1 lb / week', delta: -500 },
  { id: 'lose05', label: 'Lose ½ lb / week', delta: -250 },
  { id: 'maintain', label: 'Maintain weight', delta: 0 },
  { id: 'gain05', label: 'Gain ½ lb / week', delta: 250 },
];

const LB_KG = 0.45359237;
const IN_CM = 2.54;

// Macro splits as % of calories: protein / carbs / fat.
export const MACRO_PRESETS = [
  { id: 'balanced', label: 'Balanced', p: 30, c: 40, f: 30 },
  { id: 'high_protein', label: 'High protein', p: 40, c: 30, f: 30 },
  { id: 'lower_carb', label: 'Lower carb', p: 40, c: 20, f: 40 },
  { id: 'keto', label: 'Keto', p: 25, c: 5, f: 70 },
  { id: 'custom', label: 'Custom' },
];

export function defaultProfile() {
  return {
    sex: 'male', age: '', units: 'imperial',
    heightFt: '', heightIn: '', weightLb: '', heightCm: '', weightKg: '',
    activity: 'very', goal: 'maintain',
    calculated: false, // results show once Calculate has been tapped
    calorieOverride: '', // own calorie number for macros; blank = use the target
    macroPreset: 'balanced', customP: '30', customC: '40', customF: '30',
    meals: 3,
    macrosCalculated: false,
  };
}

const num = (v) => parseFloat(v) || 0;
const round10 = (n) => Math.round(n / 10) * 10;

export function metrics(p) {
  const imperial = p.units === 'imperial';
  return {
    age: num(p.age),
    heightCm: imperial ? (num(p.heightFt) * 12 + num(p.heightIn)) * IN_CM : num(p.heightCm),
    weightKg: imperial ? num(p.weightLb) * LB_KG : num(p.weightKg),
  };
}

// Returns null until the inputs are filled in with plausible adult values.
export function estimate(p) {
  const { age, heightCm, weightKg } = metrics(p);
  if (age < 13 || age > 100 || heightCm < 100 || heightCm > 250 || weightKg < 30 || weightKg > 350) return null;

  const bmr = 10 * weightKg + 6.25 * heightCm - 5 * age + (p.sex === 'male' ? 5 : -161);
  const activity = ACTIVITY.find((a) => a.id === p.activity) ?? ACTIVITY[3];
  const goal = GOALS.find((g) => g.id === p.goal) ?? GOALS[2];
  const tdee = bmr * activity.factor;
  const floor = p.sex === 'male' ? 1500 : 1200; // common minimum without medical supervision
  const raw = tdee + goal.delta;

  return {
    bmr: round10(bmr),
    tdee: round10(tdee),
    target: round10(Math.max(floor, raw)),
    floored: raw < floor,
    goal,
  };
}

// Switch units, converting whatever has been entered.
export function convertUnits(p, units) {
  if (units === p.units) return p;
  const { heightCm, weightKg } = metrics(p);
  if (units === 'metric') {
    return { ...p, units, heightCm: heightCm ? String(Math.round(heightCm)) : '', weightKg: weightKg ? String(Math.round(weightKg * 10) / 10) : '' };
  }
  const totalIn = Math.round(heightCm / IN_CM);
  return {
    ...p, units,
    heightFt: heightCm ? String(Math.floor(totalIn / 12)) : '',
    heightIn: heightCm ? String(totalIn % 12) : '',
    weightLb: weightKg ? String(Math.round(weightKg / LB_KG)) : '',
  };
}

// ---- Macros ------------------------------------------------------------------------

export const MIN_CALORIES = 800;
export const MAX_CALORIES = 8000;

// The protein/carbs/fat percentages in use, or null if a custom split doesn't add up to 100.
export function macroSplit(p) {
  const preset = MACRO_PRESETS.find((m) => m.id === p.macroPreset) ?? MACRO_PRESETS[0];
  if (preset.id !== 'custom') return { p: preset.p, c: preset.c, f: preset.f };
  const split = { p: num(p.customP), c: num(p.customC), f: num(p.customF) };
  if ([split.p, split.c, split.f].some((x) => x < 0) || Math.round(split.p + split.c + split.f) !== 100) return null;
  return split;
}

// Calories the macros are based on: the user's own number if valid, else the target.
export function calorieBasis(p) {
  const own = num(p.calorieOverride);
  if (own >= MIN_CALORIES && own <= MAX_CALORIES) return { calories: Math.round(own), own: true };
  const est = estimate(p);
  return est ? { calories: est.target, own: false } : null;
}

// Daily grams (4 cal/g protein and carbs, 9 cal/g fat), per meal, and protein per lb.
export function macros(p) {
  const basis = calorieBasis(p);
  const split = macroSplit(p);
  if (!basis || !split) return null;
  const part = (pct, calPerGram) => {
    const cal = (basis.calories * pct) / 100;
    return { pct, cal: Math.round(cal), g: Math.round(cal / calPerGram) };
  };
  const protein = part(split.p, 4);
  const carbs = part(split.c, 4);
  const fat = part(split.f, 9);
  const meals = Math.min(8, Math.max(1, Math.round(num(p.meals)) || 3));
  const { weightKg } = metrics(p);
  return {
    ...basis,
    protein, carbs, fat, meals,
    perMeal: { protein: Math.round(protein.g / meals), carbs: Math.round(carbs.g / meals), fat: Math.round(fat.g / meals) },
    proteinPerLb: weightKg > 0 ? Math.round((protein.g / (weightKg / LB_KG)) * 100) / 100 : null,
  };
}
