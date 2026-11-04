// Los mismos valores que en extension/config.js (Project Settings → API en Supabase).
export const CONFIG = {
  SUPABASE_URL: "https://TU-PROYECTO.supabase.co",
  SUPABASE_ANON_KEY: "TU-ANON-KEY",
};
export const isConfigured = () => !/TU-PROYECTO|TU-ANON-KEY/.test(CONFIG.SUPABASE_URL + CONFIG.SUPABASE_ANON_KEY);
