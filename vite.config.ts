import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

function mockApiCatalogPlugin(): Plugin {
  return {
    name: 'mock-api-catalog',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/')) {
          return next();
        }

        const parsedUrl = new URL(req.url, 'http://localhost');
        const pathname = parsedUrl.pathname;

        const handledPaths = new Set([
          '/api/medications',
          '/api/medications/cursor',
          '/api/medicines',
          '/api/customers',
          '/api/orders',
        ]);

        if (!handledPaths.has(pathname)) {
          return next();
        }

        const page = Math.max(1, parseInt(parsedUrl.searchParams.get('page') || '1', 10));
        const search = (parsedUrl.searchParams.get('q') || '').toLowerCase();

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');

        // 1. Customers API (/api/customers) — 120 records across 4 pages
        if (pathname === '/api/customers') {
          const limit = parseInt(parsedUrl.searchParams.get('limit') || '30', 10);
          const tiers = ['Platinum', 'Gold', 'Silver', 'Standard'];
          const cities = ['Nairobi', 'Dar es Salaam', 'Kampala', 'Kigali', 'Accra'];

          const allCustomers = Array.from({ length: 120 }, (_, idx) => {
            const id = idx + 1;
            const tier = tiers[idx % tiers.length];
            const city = cities[idx % cities.length];
            return {
              id: `cust-${String(id).padStart(3, '0')}`,
              fullName: `Customer Clinic #${id}`,
              email: `procurement${id}@healthpartner.org`,
              tier,
              loyaltyPoints: (id * 140) % 4500,
              activeAccount: id % 9 !== 0,
              address: {
                city,
                zone: `Sector ${(id % 6) + 1}`,
              },
              segments: [tier.toLowerCase(), 'verified-buyer'],
            };
          });

          const filtered = search
            ? allCustomers.filter(
                (c) =>
                  c.fullName.toLowerCase().includes(search) ||
                  c.address.city.toLowerCase().includes(search) ||
                  c.tier.toLowerCase().includes(search)
              )
            : allCustomers;

          const startIndex = (page - 1) * limit;
          const pageItems = filtered.slice(startIndex, startIndex + limit);
          const totalPages = Math.max(1, Math.ceil(filtered.length / limit));

          res.end(
            JSON.stringify({
              meta: {
                currentPage: page,
                perPage: limit,
                totalCount: filtered.length,
                totalPages,
              },
              facets: [
                { key: 'Platinum', count: 30 },
                { key: 'Gold', count: 30 },
              ],
              customers: pageItems,
            })
          );
          return;
        }

        // 2. Orders API (/api/orders) — 90 records across 3 pages
        if (pathname === '/api/orders') {
          const limit = parseInt(parsedUrl.searchParams.get('limit') || '30', 10);
          const statuses = ['Fulfilled', 'Processing', 'In Transit', 'Pending Approval'];

          const allOrders = Array.from({ length: 90 }, (_, idx) => {
            const id = idx + 1;
            return {
              orderId: `ORD-${2026000 + id}`,
              customerName: `Customer Clinic #${(id % 40) + 1}`,
              status: statuses[idx % statuses.length],
              lineItemsCount: (id % 8) + 1,
              totalUsd: Number((85 + ((id * 37.5) % 1400)).toFixed(2)),
              orderedAt: new Date(Date.now() - id * 3600_000 * 6).toISOString().slice(0, 10),
            };
          });

          const filtered = search
            ? allOrders.filter(
                (o) =>
                  o.orderId.toLowerCase().includes(search) ||
                  o.customerName.toLowerCase().includes(search) ||
                  o.status.toLowerCase().includes(search)
              )
            : allOrders;

          const startIndex = (page - 1) * limit;
          const pageItems = filtered.slice(startIndex, startIndex + limit);
          const totalPages = Math.max(1, Math.ceil(filtered.length / limit));

          res.end(
            JSON.stringify({
              pagination: {
                page,
                pageSize: limit,
                total: filtered.length,
                totalPages,
              },
              orders: pageItems,
            })
          );
          return;
        }

        // 3. Medicines / Medications API (/api/medicines, /api/medications, /api/medications/cursor)
        const limit = parseInt(parsedUrl.searchParams.get('limit') || '50', 10);
        const categories = [
          'analgesic',
          'antibiotic',
          'antipyretic',
          'antihistamine',
          'cardiovascular',
        ];
        const allItems = Array.from({ length: 250 }, (_, i) => {
          const id = i + 1;
          const cat = categories[i % categories.length];
          return {
            id: `med-${id}`,
            name: `Medicine Formulation #${id}`,
            category: cat,
            strength: {
              value: ((id * 25) % 500) + 50,
              unit: 'mg',
            },
            price: Number((10 + ((id * 1.5) % 90)).toFixed(2)),
            inStock: id % 7 !== 0,
            tags: [cat, 'oral', 'essential'],
          };
        });

        const filtered = search
          ? allItems.filter(
              (item) =>
                item.name.toLowerCase().includes(search) ||
                item.category.toLowerCase().includes(search)
            )
          : allItems;

        const startIndex = (page - 1) * limit;
        const pageItems = filtered.slice(startIndex, startIndex + limit);
        const totalPages = Math.max(1, Math.ceil(filtered.length / limit));

        if (pathname === '/api/medications/cursor') {
          const nextCursor =
            startIndex + limit < filtered.length ? `cursor_${startIndex + limit}` : null;
          res.end(
            JSON.stringify({
              results: pageItems,
              nextCursor,
              total: filtered.length,
            })
          );
          return;
        }

        res.end(
          JSON.stringify({
            facets: categories.map((c) => ({ category: c, active: true })),
            data: {
              items: pageItems,
              page,
              limit,
              totalItems: filtered.length,
              totalPages,
            },
          })
        );
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), mockApiCatalogPlugin()],
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
