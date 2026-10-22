import React, { useState, useEffect } from 'react';
import { Pill, Search, RefreshCw, ChevronLeft, ChevronRight, Activity } from 'lucide-react';

interface Medication {
  id: string;
  name: string;
  category: string;
  strength: { value: number; unit: string };
  price: number;
  inStock: boolean;
  tags: string[];
}

export const DemoCatalog: React.FC = () => {
  const [items, setItems] = useState<Medication[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(5);
  const [totalItems, setTotalItems] = useState(250);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [lastRequestUrl, setLastRequestUrl] = useState('');
  const [useCursor, setUseCursor] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);

  const fetchMedications = async (targetPage: number, query = search) => {
    setLoading(true);
    try {
      let url = `/api/medications?page=${targetPage}&limit=50`;
      if (query) {
        url += `&q=${encodeURIComponent(query)}`;
      }
      if (useCursor) {
        url = `/api/medications/cursor?page=${targetPage}&limit=50`;
      }
      setLastRequestUrl(url);

      const res = await fetch(url);
      const json = await res.json();

      if (json.data?.items) {
        setItems(json.data.items);
        setTotalPages(json.data.totalPages || 5);
        setTotalItems(json.data.totalItems || 250);
      } else if (json.results) {
        setItems(json.results);
        setCursor(json.nextCursor);
        setTotalItems(json.total || 250);
      }
    } catch (err) {
      console.error('Fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMedications(page, search);
  }, [page, useCursor]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    fetchMedications(1, search);
  };

  return (
    <div className="max-w-6xl mx-auto p-6">
      {/* Header */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-indigo-50 text-indigo-600 rounded-lg">
              <Pill className="w-7 h-7" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900">Demo Medication Catalog</h1>
              <p className="text-sm text-slate-500">
                Test target website that emits real JSON API responses for extension validation
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => fetchMedications(page)}
              disabled={loading}
              className="inline-flex items-center gap-2 px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium rounded-lg transition"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              Reload Page
            </button>
            <button
              onClick={() => {
                setUseCursor(!useCursor);
                setPage(1);
              }}
              className={`px-3 py-2 text-sm font-medium rounded-lg transition border ${
                useCursor
                  ? 'bg-indigo-50 border-indigo-200 text-indigo-700'
                  : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
              }`}
            >
              Mode: {useCursor ? 'Cursor API' : 'Page Number API'}
            </button>
          </div>
        </div>

        {/* Live Network Notice */}
        <div className="mt-4 pt-4 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-emerald-500 animate-pulse" />
            <span>Latest API Request: <code className="bg-slate-100 px-1.5 py-0.5 rounded text-indigo-600 font-mono">{lastRequestUrl || 'none'}</code></span>
            {useCursor && cursor && (
              <span className="font-mono text-purple-600 bg-purple-50 px-1.5 py-0.5 rounded text-[11px]">
                next: {cursor}
              </span>
            )}
          </div>
          <span>Total catalog: {totalItems} medications</span>
        </div>
      </div>

      {/* Search & Filters */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 mb-6">
        <form onSubmit={handleSearch} className="flex gap-3">
          <div className="relative flex-1">
            <Search className="w-5 h-5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search medications by name or category (e.g. Paracetamol, antibiotic)..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition"
            />
          </div>
          <button
            type="submit"
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium rounded-lg transition"
          >
            Search
          </button>
          {search && (
            <button
              type="button"
              onClick={() => {
                setSearch('');
                fetchMedications(1, '');
              }}
              className="px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-600 text-sm font-medium rounded-lg transition"
            >
              Clear
            </button>
          )}
        </form>
      </div>

      {/* Medications Table */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between bg-slate-50/50">
          <span className="text-sm font-semibold text-slate-700">
            Showing Page {page} of {totalPages} ({items.length} items on this page)
          </span>
          <div className="flex items-center gap-2">
            <button
              disabled={page <= 1 || loading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="inline-flex items-center gap-1 px-3 py-1.5 bg-white border border-slate-200 rounded-md text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-3.5 h-3.5" /> Previous Page
            </button>
            <div className="flex items-center gap-1">
              {[1, 2, 3, 4, 5].slice(0, totalPages).map((p) => (
                <button
                  key={p}
                  onClick={() => setPage(p)}
                  className={`w-7 h-7 rounded text-xs font-semibold ${
                    page === p
                      ? 'bg-indigo-600 text-white'
                      : 'bg-white text-slate-700 hover:bg-slate-100 border border-slate-200'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
            <button
              disabled={page >= totalPages || loading}
              onClick={() => setPage((p) => p + 1)}
              className="inline-flex items-center gap-1 px-3 py-1.5 bg-white border border-slate-200 rounded-md text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Next Page <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-700">
            <thead className="bg-slate-50 text-xs uppercase font-semibold text-slate-500 border-b border-slate-200">
              <tr>
                <th className="px-6 py-3">ID</th>
                <th className="px-6 py-3">Medication Name</th>
                <th className="px-6 py-3">Category</th>
                <th className="px-6 py-3">Strength</th>
                <th className="px-6 py-3">Price</th>
                <th className="px-6 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-slate-400">
                    <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-indigo-500" />
                    Fetching items from API...
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-slate-400">
                    No medications found.
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50/80 transition">
                    <td className="px-6 py-3 font-mono text-xs text-slate-500">{item.id}</td>
                    <td className="px-6 py-3 font-medium text-slate-900">{item.name}</td>
                    <td className="px-6 py-3">
                      <span className="px-2 py-0.5 text-xs font-medium bg-slate-100 text-slate-700 rounded-full">
                        {item.category}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-slate-600">
                      {item.strength.value} {item.strength.unit}
                    </td>
                    <td className="px-6 py-3 font-mono font-medium text-slate-900">
                      ${item.price.toFixed(2)}
                    </td>
                    <td className="px-6 py-3">
                      {item.inStock ? (
                        <span className="inline-flex items-center gap-1 text-xs text-emerald-600 font-medium">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> In Stock
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-amber-600 font-medium">
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-500"></span> Out of Stock
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
