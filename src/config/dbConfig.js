import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
// Use the secret service_role key for backend operations to bypass RLS policies!
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error("[Database-Engine-Crash] Supabase connection fault: Missing keys in .env");
}

export const supabase = createClient(supabaseUrl, supabaseKey);

export const connectDB = async () => {
    console.log(`\n[Database-Engine] Supabase Database Cluster active: ${supabaseUrl}`);
};
