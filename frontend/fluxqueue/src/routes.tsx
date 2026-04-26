// src/router.tsx
import { createBrowserRouter } from "react-router-dom";
import JobList from "./pages/JobList";
import JobDetail from "./pages/JobDetail";
import Dashboard from "./pages/Dashboard";

const router = createBrowserRouter([
  {
    path: "/",
    element: <JobList />,
  },
  {
    path: "/jobs/:id",
    element: <JobDetail />,
  },
  {
    path: "/dashboard",
    element: <Dashboard />,
  },
]);

export default router;
