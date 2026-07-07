# EcoFirma

Plataforma distribuida para gestión documental y firma digital asíncrona.

## Arquitectura

El ecosistema incluye:

- Frontend React/Vite.
- API Gateway Node.js.
- Users Service.
- Documents Service.
- Signature Worker tipo Lambda/server function.
- PostgreSQL, Redis y RabbitMQ en Docker.
- Prometheus y Grafana para monitoreo.

## Ejecución local

```bash
cp .env.example .env
docker compose up --build
```

URLs principales:

- Frontend: http://localhost:5188
- API Gateway: http://localhost:8081
- RabbitMQ UI: http://localhost:15673
- Prometheus: http://localhost:9090
- Grafana: http://localhost:3001

## Despliegue público en GitHub Pages

El frontend se despliega automáticamente en GitHub Pages mediante el workflow:

```text
.github/workflows/pages.yml
```

URL pública esperada:

```text
https://alejandro-moreira.github.io/Proyecto-Dise-o-Arquitectura/
```

GitHub Pages hospeda únicamente la aplicación estática de React/Vite. Para que la aplicación funcione completamente fuera de `localhost`, el API Gateway y los servicios de backend deben desplegarse en un proveedor de nube como Render, Railway, Fly.io, AWS o Azure.

Cuando exista una URL pública para el API Gateway, debe configurarse como variable del repositorio en GitHub:

```text
VITE_API_URL=https://url-publica-del-api-gateway
```

Ruta en GitHub:

```text
Settings -> Secrets and variables -> Actions -> Variables -> New repository variable
```

## Flujo de demo

1. Registrar usuario.
2. Iniciar sesión.
3. Crear documento.
4. Listar documentos.
5. Solicitar firma.
6. Signature Worker consume el mensaje desde RabbitMQ.
7. Documents Service actualiza el documento a `FIRMADO`.
8. Consultar estado del documento.

## Documentación

- OpenAPI: `docs/openapi.yaml`
- Arquitectura y despliegue: `docs/arquitectura-y-despliegue.md`

## Pruebas

```bash
cd users-service
npm test

cd ../documents-service
npm test
```

## CI/CD y monitoreo

El proyecto incluye workflows de GitHub Actions para CI, CD y escaneo de seguridad. El stack de monitoreo usa Prometheus y Grafana con configuración en `monitoring/`.
