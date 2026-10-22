import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

function mockMedicationApiPlugin(): Plugin {
  return {
    name: 'mock-medication-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/medications')) {
          return next();
        }

        const parsedUrl = new URL(req.url, 'http://localhost');
        const page = parseInt(parsedUrl.searchParams.get('page') || '1', 10);
        const limit = parseInt(parsedUrl.searchParams.get('limit') || '50', 10);
        const search = (parsedUrl.searchParams.get('q') || '').toLowerCase();

        // 250 mock medications
        const categories = ['analgesic', 'antibiotic', 'antipyretic', 'antihistamine', 'cardiovascular'];
        const allItems = Array.from({ length: 250 }, (_, i) => {
          const id = i + 1;
          const cat = categories[i % categories.length];
          return {
            id: `med-${id}`,
            name: `Medication Sample #${id}`,
            category: cat,
            strength: {
              value: ((id * 25) % 500) + 50,
              unit: 'mg',
            },
            price: Number((10 + (id * 1.5) % 90).toFixed(2)),
            inStock: id % 7 !== 0,
            tags: [cat, 'oral', 'prescription'],
          };
        });

        let filtered = allItems;
        if (search) {
          filtered = filtered.filter(
            (item) =>
              item.name.toLowerCase().includes(search) ||
              item.category.toLowerCase().includes(search)
          );
        }

        const startIndex = (page - 1) * limit;
        const pageItems = filtered.slice(startIndex, startIndex + limit);

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');

        if (parsedUrl.pathname === '/api/medications/cursor') {
          // Cursor pagination
          const nextCursor = startIndex + limit < filtered.length ? `cursor_${startIndex + limit}` : null;
          res.end(
            JSON.stringify({
              results: pageItems,
              nextCursor,
              total: filtered.length,
            })
          );
          return;
        }

        // Standard data.items shape
        res.end(
          JSON.stringify({
            data: {
              items: pageItems,
              page,
              limit,
              totalItems: filtered.length,
              totalPages: Math.ceil(filtered.length / limit),
            },
          })
        );
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), mockMedicationApiPlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        dashboard: resolve(__dirname, 'dashboard.html'),
        sidepanel: resolve(__dirname, 'sidepanel.html'),
        demo: resolve(__dirname, 'demo.html'),
        background: resolve(__dirname, 'src/background/service-worker.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background') {
            return 'background.js';
          }
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
});
