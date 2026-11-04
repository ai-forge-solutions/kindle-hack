// Rellena estos valores con los de tu proyecto de Supabase (Project Settings → API).
// La clave "anon" es pública: la seguridad la ponen las políticas RLS de la base de datos.
export const CONFIG = {
  SUPABASE_URL: "https://TU-PROYECTO.supabase.co",
  SUPABASE_ANON_KEY: "TU-ANON-KEY",
  // Dónde está publicada la web de repaso (Netlify).
  WEB_URL: "https://TU-WEB.netlify.app",
};
export const isConfigured = () => !/TU-PROYECTO|TU-ANON-KEY/.test(CONFIG.SUPABASE_URL + CONFIG.SUPABASE_ANON_KEY);
