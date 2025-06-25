# Sancus

**Sancus** is a lightweight, Node.js-based **API Gateway** designed to sit at the edge of your application architecture. It offers configurable routing, middleware bypass options, and optional Kubernetes orchestration support for scalable deployments.

---

## 🚀 Features

- Declarative YAML-based API configuration
- Supports multiple services with custom route definitions
- Middleware bypass support (e.g., `AUTH`, `GEO_FENCE`)
- Environment-driven host/port mappings
- Optional Kubernetes deployment configs for staging & production

---

## 🧱 Project Structure

```

.
├── api\configs/          # YAML configs for each service and API routes
├── k8s/                  # (Optional) K8s deployment, service, and ingress manifests
├── src/
│   └── clients/
│       └── veritasClient.ts    # Client for external auth service
├── .env                  # Environment variables (host mappings, VERITAS_URL, etc.)

```

---

## 🔧 API Config Format

Example `api_configs/example.yaml`:

```yaml
service:
  name: your_service_name
  host: YOUR_SERVICE_HOST # Should match key in .env
  port: 80

  apis:
    - name: Example Resource
      description: Sample API
      routes:
        - path: /v1/example/api
          methods: [POST]
        - path: /v1/example/api
          methods: [GET]
          bypass: [AUTH, GEO_FENCE]
```

---

## ⚙️ Setup

1. **Clone the repository**

   ```bash
   git clone https://github.com/ramsuthar305/sancus.git
   cd sancus
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Configure environment**

   - Create a `.env` file with the required service host mappings:

     ```
     YOUR_SERVICE_HOST=http://localhost
     VERITAS_URL=http://auth-service
     ```

4. **Run the gateway**

   ```bash
   npm run build
   npm start
   ```

   Or

   ```bash
   npm run dev
   ```

---

## ☸️ Kubernetes Deployment (Optional)

Use the `k8s/` directory for orchestration:

- `deployment.yaml`, `service.yaml`: Define your gateway pod and service
- `stage-ingress.yaml`, `prod-ingress.yaml`: Ingress configs for different environments

> The gateway acts as the **single public entrypoint** to your cluster.

---

## 🔐 Authentication Client (Veritas)

Update the `src/clients/veritasClient.ts` client and `.env` with the appropriate `VERITAS_URL` to use your authentication service.

---

## 📜 License

MIT License. See `LICENSE` file for details.

---

## 🙌 Contributing

Pull requests and issues are welcome! Please fork the repo and submit a PR with your changes.
