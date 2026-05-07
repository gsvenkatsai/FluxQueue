// src/pages/Dashboard.tsx
import { useEffect, useState } from "react";
import JobStatusPieChart from "../components/JobStatusPieChart";
import WorkerHealthTable from "../components/WorkerHealthTable";
import AvgExecTable from "../components/AvgExecTable";
import ThroughputChart from "../components/ThroughputChart";
import QueueDepthBars from "../components/QueueDepthBars";

interface ThroughputPoint {
  minute: string;
  count: number;
}

interface Stats {
  pending_count: number;
  running_count: number;
  completed_count: number;
  failed_count: number;
  dead_count: number;
  total_jobs: number;
  queue_depth: number;
  jobs_per_minute: number;
  workers: { hostname: string; is_online: boolean; active_jobs: number }[];
  failure_rate: number;
  avg_exec_per_type: Record<string, number>;
  throughput: ThroughputPoint[];
  avg_execution_time_ms: number | null;
  queue_depth_high: number;
  queue_depth_default: number;
  queue_depth_low: number;
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: string;
}) {
  return (
    <div
      className={`bg-gray-800 rounded-xl p-5 border ${accent ?? "border-gray-700"} shadow-lg`}
    >
      <p className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-1">
        {label}
      </p>
      <p className="text-3xl font-bold text-white">{value}</p>
    </div>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    const fetchStats = () =>
      fetch("http://localhost:8000/api/stats/")
        .then((r) => r.json())
        .then((data) => setStats(data));

    fetchStats();
    const interval = setInterval(fetchStats, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let ws: WebSocket;
    const connect = () => {
      ws = new WebSocket("ws://localhost:8000/ws/stats/");
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.data) {
          setStats((prev) => ({ ...prev, ...msg.data }));
        }
      };
      ws.onclose = () => setTimeout(connect, 3000);
    };
    connect();
    return () => ws.close();
  }, []);

  if (!stats)
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <p className="text-gray-400 text-lg animate-pulse">
          Loading dashboard...
        </p>
      </div>
    );

  const failureColor =
    stats.failure_rate < 5
      ? "border-green-500"
      : stats.failure_rate < 20
        ? "border-yellow-500"
        : "border-red-500";

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">FluxQueue</h1>
          <p className="text-gray-400 text-sm mt-1">Observability Dashboard</p>
        </div>
        <span className="flex items-center gap-2 text-sm text-green-400 bg-green-400/10 px-3 py-1 rounded-full border border-green-400/20">
          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse inline-block" />
          Live
        </span>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard label="Total Jobs" value={stats.total_jobs} />
        <StatCard
          label="Pending"
          value={stats.pending_count}
          accent="border-yellow-500/40"
        />
        <StatCard
          label="Completed"
          value={stats.completed_count}
          accent="border-green-500/40"
        />
        <StatCard
          label="Failure Rate"
          value={`${stats.failure_rate.toFixed(1)}%`}
          accent={failureColor}
        />
        <StatCard label="Queue Depth" value={stats.queue_depth} />
        <StatCard
          label="Running"
          value={stats.running_count}
          accent="border-blue-500/40"
        />
        <StatCard
          label="Failed"
          value={stats.failed_count}
          accent="border-red-500/40"
        />
        <StatCard
          label="Dead"
          value={stats.dead_count}
          accent="border-gray-500/40"
        />
      </div>

      {/* Middle row: Pie + Workers + Avg Exec */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 shadow-lg md:col-span-1">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-4">
            Job Status
          </p>
          <JobStatusPieChart {...stats} />
        </div>
        <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 shadow-lg">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-4">
            Workers
          </p>
          <WorkerHealthTable workers={stats.workers} />
        </div>
        <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 shadow-lg">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-4">
            Avg Exec Time
          </p>
          <AvgExecTable data={stats.avg_exec_per_type} />
        </div>
      </div>

      {/* Throughput Chart */}
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 shadow-lg">
        <p className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-4">
          Throughput — last 60 min
        </p>
        <ThroughputChart data={stats.throughput ?? []} />
      </div>
      <div className="bg-gray-800 rounded-xl p-5 border border-gray-700 shadow-lg mt-4">
        <p className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-4">
          Queue Depth by Priority
        </p>
        <QueueDepthBars
          high={stats.queue_depth_high}
          default_={stats.queue_depth_default}
          low={stats.queue_depth_low}
        />
      </div>
    </div>
  );
}
