// src/pages/Dashboard.tsx
import { useEffect, useState } from "react";
import JobStatusPieChart from "../components/JobStatusPieChart";
import WorkerHealthTable from "../components/WorkerHealthTable";
import AvgExecTable from "../components/AvgExecTable";
import ThroughputChart from "../components/ThroughputChart";

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
  workers: { hostname: string; is_online: boolean; active_jobs: number }[];
  failure_rate: number;
  avg_exec_per_type: Record<string, number>;
  throughput: ThroughputPoint[];
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    fetch("http://localhost:8000/api/stats/")
      .then((r) => r.json())
      .then((data) => setStats(data));
  }, []);

  useEffect(() => {
    let ws: WebSocket;
    const connect = () => {
      ws = new WebSocket("ws://localhost:8000/ws/stats/");
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        // WS sends {type, data: {...}}
        if (msg.data) {
          setStats((prev) => ({ ...prev, ...msg.data }));
        }
      };
      ws.onclose = () => setTimeout(connect, 3000);
    };
    connect();
    return () => ws.close();
  }, []);

  if (!stats) return <p>Loading...</p>;

  return (
    <div style={{ padding: "2rem" }}>
      <h1>Dashboard</h1>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "2rem",
          flexWrap: "wrap",
        }}
      >
        <JobStatusPieChart {...stats} />
        <span>Failure Rate: {stats.failure_rate.toFixed(1)}%</span>
        <WorkerHealthTable workers={stats.workers} />
        <AvgExecTable data={stats.avg_exec_per_type} />
      </div>
      <div style={{ marginTop: "2rem" }}>
        <ThroughputChart data={stats.throughput ?? []} />
      </div>
    </div>
  );
}
