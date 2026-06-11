import ReactDOM from "react-dom/client";
import App from "./App";

// no StrictMode: double-mounted effects would churn the live audio graph
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
