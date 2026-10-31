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

export function defaultProfile() {
  return {
    sex: 'male', age: '', units: 'imperial',
    heightFt: '', heightIn: '', weightLb: '', heightCm: '', weightKg: '',
    activity: 'very', goal: 'maintain',
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
