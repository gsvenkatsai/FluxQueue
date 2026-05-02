// src/pages/JobDetail.tsx
import axios from "axios";
import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";

interface Log {
  id: string;
  level: string;
  message: string;
  created_at: string;
  job: string;
}

interface Job {
  id: string;
  job_type: string;
  status: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  retry_count: number;
  error_msg: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  logs: Log[];
}

const STATUS_STYLES: Record<string, string> = {
  PENDING: "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30",
  RUNNING: "bg-blue-500/20 text-blue-400 border border-blue-500/30",
  COMPLETED: "bg-green-500/20 text-green-400 border border-green-500/30",
  FAILED: "bg-red-500/20 text-red-400 border border-red-500/30",
  DEAD: "bg-gray-500/20 text-gray-400 border border-gray-500/30",
};

const LEVEL_STYLES: Record<string, string> = {
  INFO: "bg-blue-500/20 text-blue-400",
  WARNING: "bg-yellow-500/20 text-yellow-400",
  ERROR: "bg-red-500/20 text-red-400",
};

const JobDetail = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [job, setJob] = useState<Job | null>(null);
  const [logs, setLogs] = useState<Log[]>([]);

  useEffect(() => {
    const ws = new WebSocket(`ws://127.0.0.1:8000/ws/jobs/${id}/`);
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.status) setJob((prev) => (prev ? { ...prev, status: data.status } : prev));
      else if (data.log) setLogs((prev) => [...prev, data.log]);
    };
    axios.get<Job>(`http://127.0.0.1:8000/api/jobs/${id}/`).then((res) => {
      setJob(res.data);
      setLogs(res.data.logs);
    });
    return () => ws.close();
  }, []);

  return (
    <div className="min-h-screen bg-gray-900 text-white p-8">
      <div className="max-w-3xl mx-auto">
        <button
          onClick={() => navigate("/")}
          className="mb-6 flex items-center gap-2 text-gray-400 hover:text-white text-sm transition"
        >
          ← Back
        </button>

        {job && (
          <div className="bg-gray-800 rounded-xl border border-gray-700 p-6 mb-6 shadow-lg">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold font-mono">{job.job_type}</h2>
              <span className={`px-3 py-1 rounded-full text-xs font-bold ${STATUS_STYLES[job.status] ?? "bg-gray-700 text-gray-300"}`}>
                {job.status}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-2 text-sm">
              <div className="flex gap-2">
                <span className="text-gray-400 w-24 flex-shrink-0">ID</span>
                <span className="font-mono text-gray-300 text-xs break-all">{job.id}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-gray-400 w-24 flex-shrink-0">Payload</span>
                <span className="font-mono text-gray-300 text-xs">{JSON.stringify(job.payload)}</span>
              </div>
              {job.result && (
                <div className="flex gap-2">
                  <span className="text-gray-400 w-24 flex-shrink-0">Result</span>
                  <span className="font-mono text-gray-300 text-xs">{JSON.stringify(job.result)}</span>
                </div>
              )}
              <div className="flex gap-2">
                <span className="text-gray-400 w-24 flex-shrink-0">Created</span>
                <span className="text-gray-300">{new Date(job.created_at).toLocaleString()}</span>
              </div>
            </div>
          </div>
        )}

        {/* Logs */}
        <div className="bg-gray-800 rounded-xl border border-gray-700 p-6 shadow-lg">
          <p className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-4">Logs</p>
          {logs.length === 0 && <p className="text-gray-500 text-sm">No logs yet.</p>}
          <div className="flex flex-col gap-2">
            {logs.map((log, i) => (
              <div key={i} className="flex items-start justify-between gap-4 border-b border-gray-700/50 pb-2">
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded text-xs font-semibold ${LEVEL_STYLES[log.level] ?? "bg-gray-700 text-gray-300"}`}>
                    {log.level}
                  </span>
                  <span className="text-gray-300 text-sm">{log.message}</span>
                </div>
                <span className="text-gray-500 text-xs whitespace-nowrap">
                  {new Date(log.created_at).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default JobDetail;
