import React, { useState, useEffect, useId } from 'react';
import {
  Pill,
  Users,
  ShoppingBag,
  Search,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Activity,
} from 'lucide-react';

type DemoDataset = 'medicines' | 'customers' | 'orders';

export const DemoCatalog: React.FC = () => {
  const [dataset, setDataset] = useState<DemoDataset>('medicines');
  const [items, setItems] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(5);
  const [totalItems, setTotalItems] = useState(250);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [lastRequestUrl, setLastRequestUrl] = useState('');
  const [useCursor, setUseCursor] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const captionId = useId();

  const fetchDataset = async (
    targetDataset: DemoDataset,
    targetPage: number,
    query = search,
    cursorMode = useCursor
  ) => {
    setLoading(true);
    try {
      let url = '';
      if (targetDataset === 'medicines') {
        url = cursorMode
          ? `/api/medications/cursor?page=${targetPage}&limit=50`
          : `/api/medicines?page=${targetPage}&limit=50`;
      } else if (targetDataset === 'customers') {
        url = `/api/customers?page=${targetPage}&limit=30`;
      } else {
        url = `/api/orders?page=${targetPage}&limit=30`;
      }

      if (query) {
        url += `&q=${encodeURIComponent(query)}`;
      }

      setLastRequestUrl(url);

      const res = await fetch(url);
      const json = await res.json();

      if (json.data?.items) {
        setItems(json.data.items);
        setTotalPages(json.data.totalPages || 5);
        setTotalItems(json.data.totalItems || 250);
        setCursor(null);
      } else if (json.customers) {
        setItems(json.customers);
        setTotalPages(json.meta?.totalPages || 4);
        setTotalItems(json.meta?.totalCount || 120);
        setCursor(null);
      } else if (json.orders) {
        setItems(json.orders);
        setTotalPages(json.pagination?.totalPages || 3);
        setTotalItems(json.pagination?.total || 90);
        setCursor(null);
      } else if (json.results) {
        setItems(json.results);
        setCursor(json.nextCursor || null);
        setTotalItems(json.total || 250);
        setTotalPages(5);
      }
    } catch (err) {
      console.error('Fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDataset(dataset, page, search, useCursor);
  }, [dataset, page, useCursor]);

  const handleDatasetSwitch = (next: DemoDataset) => {
    setDataset(next);
    setPage(1);
    setSearch('');
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchDataset(dataset, 1, search, useCursor);
  };

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      {/* Header */}
      <header className="bg-obsidian-900 text-white rounded-2xl shadow-sm border border-obsidian-800 p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div
              className="p-3 bg-obsidian-800 border border-obsidian-700 text-brand-400 rounded-xl"
              aria-hidden="true"
            >
              <Pill className="w-7 h-7" />
            </div>
            <div>
              <h1 className="text-2xl font-extrabold tracking-tight text-white">
                Multi-API Pharmacy &amp; Clinic Sandbox
              </h1>
              <p className="text-xs text-stone-300 mt-0.5">
                Live multi-page API sandbox emitting <code className="font-mono text-brand-300">/api/medicines</code>,{' '}
                <code className="font-mono text-brand-300">/api/customers</code>, and{' '}
                <code className="font-mono text-brand-300">/api/orders</code> for collector validation
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => fetchDataset(dataset, page)}
              disabled={loading}
              className="inline-flex items-center gap-2 px-3.5 py-2 bg-obsidian-800 hover:bg-obsidian-700 border border-obsidian-700 text-stone-100 text-xs font-semibold rounded-xl transition"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
              Refetch Page
            </button>

            {dataset === 'medicines' && (
              <button
                type="button"
                onClick={() => {
                  setUseCursor(!useCursor);
                  setPage(1);
                }}
                className={`px-3.5 py-2 text-xs font-bold rounded-xl transition border ${
                  useCursor
                    ? 'bg-brand-400 border-brand-300 text-brand-950'
                    : 'bg-obsidian-800 border-obsidian-700 text-stone-200 hover:bg-obsidian-700'
                }`}
              >
                Pagination: {useCursor ? 'Cursor API' : 'Page Number API'}
              </button>
            )}
          </div>
        </div>

        {/* Dataset Switcher Tabs */}
        <div className="mt-5 pt-4 border-t border-obsidian-800 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2" role="tablist" aria-label="Demo API Datasets">
            {[
              {
                id: 'medicines' as const,
                label: 'Medicines API (5 pages)',
                icon: <Pill className="w-4 h-4" aria-hidden="true" />,
              },
              {
                id: 'customers' as const,
                label: 'Customers API (4 pages)',
                icon: <Users className="w-4 h-4" aria-hidden="true" />,
              },
              {
                id: 'orders' as const,
                label: 'Orders API (3 pages)',
                icon: <ShoppingBag className="w-4 h-4" aria-hidden="true" />,
              },
            ].map((tab) => {
              const active = dataset === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => handleDatasetSwitch(tab.id)}
                  className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-bold transition ${
                    active
                      ? 'bg-brand-400 text-brand-950 shadow-xs'
                      : 'bg-obsidian-800 text-stone-300 hover:bg-obsidian-700 hover:text-white'
                  }`}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2 text-xs text-stone-300">
            <Activity className="w-4 h-4 text-brand-400 animate-pulse" aria-hidden="true" />
            <span>
              Latest API:{' '}
              <code className="bg-obsidian-800 border border-obsidian-700 px-2 py-0.5 rounded text-brand-300 font-mono">
                {lastRequestUrl || 'none'}
              </code>
            </span>
            {useCursor && cursor && (
              <span className="font-mono text-brand-950 bg-brand-300 px-2 py-0.5 rounded text-[11px] font-bold">
                next: {cursor}
              </span>
            )}
          </div>
        </div>
      </header>

      {/* Search Bar */}
      <div className="bg-white rounded-2xl shadow-xs border border-stone-200 p-4">
        <form onSubmit={handleSearch} className="flex gap-3">
          <div className="relative flex-1">
            <Search
              className="w-4 h-4 text-stone-400 absolute left-3.5 top-1/2 -translate-y-1/2"
              aria-hidden="true"
            />
            <input
              type="search"
              aria-label={`Search ${dataset}`}
              placeholder={`Search ${dataset} records...`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-stone-50 border border-stone-300 rounded-xl text-sm focus:outline-none focus:border-brand-600 focus:bg-white transition"
            />
          </div>
          <button
            type="submit"
            className="px-4 py-2 bg-obsidian-900 hover:bg-obsidian-800 text-brand-300 text-xs font-bold rounded-xl transition"
          >
            Search API
          </button>
          {search && (
            <button
              type="button"
              onClick={() => {
                setSearch('');
                fetchDataset(dataset, 1, '', useCursor);
              }}
              className="px-3 py-2 bg-stone-100 hover:bg-stone-200 text-stone-700 text-xs font-semibold rounded-xl transition"
            >
              Clear
            </button>
          )}
        </form>
      </div>

      {/* Paginated Data Table */}
      <div className="bg-white rounded-2xl shadow-xs border border-stone-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 flex flex-wrap items-center justify-between gap-3 bg-stone-50/70">
          <span className="text-xs font-bold text-stone-700">
            Showing Page {page} of {totalPages} ({items.length} of {totalItems} total {dataset})
          </span>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="inline-flex items-center gap-1 px-3 py-1.5 bg-white border border-stone-300 rounded-xl text-xs font-semibold text-stone-700 hover:bg-stone-50 disabled:opacity-45 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" /> Previous
            </button>

            <div className="flex items-center gap-1">
              {Array.from({ length: totalPages }, (_, idx) => idx + 1).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPage(p)}
                  className={`w-7 h-7 rounded-lg text-xs font-bold transition ${
                    page === p
                      ? 'bg-obsidian-900 text-brand-300'
                      : 'bg-white text-stone-700 hover:bg-stone-100 border border-stone-200'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>

            <button
              type="button"
              aria-label="Next Page"
              disabled={page >= totalPages || loading}
              onClick={() => setPage((p) => p + 1)}
              className="inline-flex items-center gap-1 px-3 py-1.5 bg-brand-400 hover:bg-brand-300 border border-brand-500 rounded-xl text-xs font-extrabold text-brand-950 disabled:opacity-45 disabled:cursor-not-allowed"
            >
              Next Page <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>

        <div
          className="table-wrapper"
          tabIndex={0}
          role="region"
          aria-labelledby={captionId}
        >
          {dataset === 'medicines' && (
            <table className="w-full text-left text-sm text-stone-700">
              <caption id={captionId} className="visually-hidden">
                Paginated Medicines API Catalog
              </caption>
              <thead className="bg-stone-100/90 text-xs uppercase font-bold text-stone-600 border-b border-stone-200">
                <tr>
                  <th scope="col" className="px-6 py-3">ID</th>
                  <th scope="col" className="px-6 py-3">Medicine Name</th>
                  <th scope="col" className="px-6 py-3">Category</th>
                  <th scope="col" className="px-6 py-3">Strength</th>
                  <th scope="col" className="px-6 py-3">Price</th>
                  <th scope="col" className="px-6 py-3">Stock</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {items.map((item) => (
                  <tr key={item.id} className="hover:bg-brand-50/30 transition">
                    <td className="px-6 py-3 font-mono text-xs text-stone-500">{item.id}</td>
                    <td className="px-6 py-3 font-semibold text-stone-900">{item.name}</td>
                    <td className="px-6 py-3">
                      <span className="px-2.5 py-0.5 text-xs font-semibold bg-brand-50 border border-brand-200 text-brand-900 rounded-full">
                        {item.category}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-stone-600">
                      {item.strength?.value} {item.strength?.unit}
                    </td>
                    <td className="px-6 py-3 font-mono font-semibold text-stone-900">
                      ${Number(item.price || 0).toFixed(2)}
                    </td>
                    <td className="px-6 py-3">
                      {item.inStock ? (
                        <span className="inline-flex items-center gap-1.5 text-xs text-brand-800 font-bold">
                          <span className="w-2 h-2 rounded-full bg-brand-600" /> In Stock
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-xs text-amber-700 font-bold">
                          <span className="w-2 h-2 rounded-full bg-amber-500" /> Low / Out
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {dataset === 'customers' && (
            <table className="w-full text-left text-sm text-stone-700">
              <caption id={captionId} className="visually-hidden">
                Paginated Customers API Directory
              </caption>
              <thead className="bg-stone-100/90 text-xs uppercase font-bold text-stone-600 border-b border-stone-200">
                <tr>
                  <th scope="col" className="px-6 py-3">Customer ID</th>
                  <th scope="col" className="px-6 py-3">Clinic / Buyer</th>
                  <th scope="col" className="px-6 py-3">Email</th>
                  <th scope="col" className="px-6 py-3">City</th>
                  <th scope="col" className="px-6 py-3">Tier</th>
                  <th scope="col" className="px-6 py-3">Loyalty Pts</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {items.map((c) => (
                  <tr key={c.id} className="hover:bg-brand-50/30 transition">
                    <td className="px-6 py-3 font-mono text-xs text-stone-500">{c.id}</td>
                    <td className="px-6 py-3 font-semibold text-stone-900">{c.fullName}</td>
                    <td className="px-6 py-3 text-xs text-stone-600 font-mono">{c.email}</td>
                    <td className="px-6 py-3 text-stone-700">{c.address?.city}</td>
                    <td className="px-6 py-3">
                      <span className="px-2.5 py-0.5 text-xs font-bold bg-brand-50 border border-brand-200 text-brand-900 rounded-full">
                        {c.tier}
                      </span>
                    </td>
                    <td className="px-6 py-3 font-mono font-semibold text-stone-900">
                      {c.loyaltyPoints}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {dataset === 'orders' && (
            <table className="w-full text-left text-sm text-stone-700">
              <caption id={captionId} className="visually-hidden">
                Paginated Orders API Ledger
              </caption>
              <thead className="bg-stone-100/90 text-xs uppercase font-bold text-stone-600 border-b border-stone-200">
                <tr>
                  <th scope="col" className="px-6 py-3">Order ID</th>
                  <th scope="col" className="px-6 py-3">Customer</th>
                  <th scope="col" className="px-6 py-3">Status</th>
                  <th scope="col" className="px-6 py-3">Line Items</th>
                  <th scope="col" className="px-6 py-3">Total (USD)</th>
                  <th scope="col" className="px-6 py-3">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {items.map((o) => (
                  <tr key={o.orderId} className="hover:bg-brand-50/30 transition">
                    <td className="px-6 py-3 font-mono text-xs font-bold text-stone-800">
                      {o.orderId}
                    </td>
                    <td className="px-6 py-3 font-semibold text-stone-900">{o.customerName}</td>
                    <td className="px-6 py-3">
                      <span className="px-2.5 py-0.5 text-xs font-bold bg-stone-100 text-stone-800 rounded-full">
                        {o.status}
                      </span>
                    </td>
                    <td className="px-6 py-3 font-mono text-stone-700">{o.lineItemsCount}</td>
                    <td className="px-6 py-3 font-mono font-bold text-stone-900">
                      ${Number(o.totalUsd || 0).toFixed(2)}
                    </td>
                    <td className="px-6 py-3 font-mono text-xs text-stone-500">{o.orderedAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};
