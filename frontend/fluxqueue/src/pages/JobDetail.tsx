import axios from "axios";
import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";

interface Job {
  id: string;
  job_type: string;
  status: string;
  payload: Record<string, any>;
  result: Record<string, any> | null;
  retry_count: number;
  error_msg: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  logs: Log[];
}

interface Log {
  id: string;
  level: string;
  message: string;
  created_at: string;
  job: string;
}

const statusBadge: Record<string, string> = {
  PENDING: "warning",
  RUNNING: "primary",
  COMPLETED: "success",
  FAILED: "danger",
};

const levelBadge: Record<string, string> = {
  INFO: "info",
  WARNING: "warning",
  ERROR: "danger",
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
      if (data.status) {
        setJob((prev) => (prev ? { ...prev, status: data.status } : prev));
      } else if (data.log) {
        setLogs((prev) => [...prev, data.log]);
      }
    };
    axios.get<Job>(`http://127.0.0.1:8000/api/jobs/${id}/`).then((res) => {
      setJob(res.data);
      setLogs(res.data.logs);
    });
    return () => ws.close();
  }, []);

  return (
    <div className="container mt-4">
      <button
        className="btn btn-outline-secondary mb-3"
        onClick={() => navigate("/")}
      >
        ← Back
      </button>

      {job && (
        <div className="card mb-4">
          <div className="card-header d-flex justify-content-between align-items-center">
            <h4 className="mb-0">{job.job_type}</h4>
            <span
              className={`badge bg-${statusBadge[job.status] || "secondary"} fs-6`}
            >
              {job.status}
            </span>
          </div>
          <div className="card-body">
            <p>
              <strong>ID:</strong> {job.id}
            </p>
            <p>
              <strong>Payload:</strong> {JSON.stringify(job.payload)}
            </p>
            {job.result && (
              <p>
                <strong>Result:</strong> {JSON.stringify(job.result)}
              </p>
            )}
            <p>
              <strong>Created:</strong>{" "}
              {new Date(job.created_at).toLocaleString()}
            </p>
          </div>
        </div>
      )}

      <h5>Logs</h5>
      <ul className="list-group">
        {logs.map((log, i) => (
          <li
            key={i}
            className="list-group-item d-flex justify-content-between align-items-start"
          >
            <div>
              <span
                className={`badge bg-${levelBadge[log.level] || "secondary"} me-2`}
              >
                {log.level}
              </span>
              {log.message}
            </div>
            <small className="text-muted">
              {new Date(log.created_at).toLocaleString()}
            </small>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default JobDetail;
