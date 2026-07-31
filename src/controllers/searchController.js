import { supabase } from '../config/dbConfig.js';
import { GoogleGenAI } from '@google/genai';

export async function searchVideosController(req, res) {
    try {
        const query = req.query.q;
        if (!query) {
            return res.status(400).json({ error: "Missing search query '?q='" });
        }

        console.log(`\n[Search-Engine] Semantic query received: "${query}"`);

        // 1. Convert the user's text search into a Vector Embedding
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const embedResponse = await ai.models.embedContent({
            model: 'gemini-embedding-2',
            contents: `task: search result | query: ${query}`,
            config: { outputDimensionality: 768 }
        });
        
        const queryVector = embedResponse.embeddings[0].values;
        // Supabase pgvector uses string representation for vectors in RPC
        const vectorString = `[${queryVector.join(',')}]`;

        // 2. Perform Cosine Similarity Search in Supabase using the match_videos RPC
        const { data, error } = await supabase.rpc('match_videos', {
            query_embedding: vectorString,
            match_threshold: 0.5, // Return matches that are at least 50% similar
            match_count: 5 // Top 5 results
        });

        if (error) {
            console.error("[Search-Engine-Crash] Supabase RPC Error:", error);
            return res.status(500).json({ error: "Failed to search vector database." });
        }

        console.log(`[Search-Engine] Found ${data.length} semantic matches!`);
        
        return res.status(200).json({ results: data });
    } catch (err) {
        console.error("[Search-Engine-Crash] Critical failure:", err);
        return res.status(500).json({ error: err.message });
    }
}
