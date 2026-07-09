# EcoFirma

Plataforma distribuida para gestión documental y firma digital asíncrona.

## Autores: Andrew Vilcacundo y Alejandro Moreira

## Arquitectura

El ecosistema incluye:

- **Frontend**: React/Vite.
- **API Gateway**: Node.js (enrutador con validación de JWT centralizada).
- **Users Service**: Gestión de usuarios (ahora migrado a PostgreSQL para compatibilidad con planes gratuitos).
- **Documents Service**: Gestión de documentos con caché Redis.
- **PostgreSQL**: Base de datos relacional compartida (pero con tablas aisladas por servicio).
- **Redis**: Caché para documentos.
- **RabbitMQ**: (Opcional, usado localmente por el `Signature Worker` para firmas asíncronas).
- **Prometheus y Grafana**: Monitoreo de métricas nativas del stack.

---

## Ejecución Local

Para levantar todo el stack localmente con Docker Compose (incluyendo RabbitMQ, MySQL para histórico si es necesario, Postgres, Redis y monitoreo):

1. **Clonar y configurar variables**:
   ```bash
   cp .env.example .env
   ```
2. **Levantar contenedores**:
   ```bash
   docker compose up --build
   ```

### URLs Locales Principales:

- **Frontend (UI)**: http://localhost:5188 o http://localhost:5173
- **API Gateway**: http://localhost:8081
- **RabbitMQ UI**: http://localhost:15673
- **Prometheus**: http://localhost:9090
- **Grafana**: http://localhost:3001 (Credenciales: `admin` / `ecofirma_grafana_admin`)

---

## Despliegue en Producción (Funcionando) 🟢

El stack completo se encuentra desplegado y funcionando de forma pública:

- **Aplicación Frontend (GitHub Pages)**: [https://alejandro-moreira.github.io/Proyecto-Dise-o-Arquitectura/](https://alejandro-moreira.github.io/Proyecto-Dise-o-Arquitectura/)
- **API Gateway (Render)**: `https://ecofirma-gateway.onrender.com`
- **Users Service (Render)**: `https://ecofirma-users-service.onrender.com`
- **Documents Service (Render)**: `https://ecofirma-documents-service.onrender.com`

> [!NOTE]
> **Limitación del Plan Gratuito (Render)**: 
> Los servicios backend están alojados en el plan gratuito de Render. Si no reciben peticiones durante 15 minutos, **se suspenden temporalmente (se duermen)**. La primera petición tras este estado puede tardar entre 30 y 50 segundos en responder mientras el contenedor se inicia de nuevo (cold start). Las siguientes peticiones serán instantáneas.

---

## Guía de Uso del Despliegue Activo

Para probar el flujo completo en la URL pública:

1. **Ingresa a la aplicación**: Abre [EcoFirma en GitHub Pages](https://alejandro-moreira.github.io/Proyecto-Dise-o-Arquitectura/).
2. **Registro**:
   - Haz clic en la pestaña **Registro**.
   - Rellena tu Nombre, Email y Contraseña (mínimo 6 caracteres).
   - Haz clic en **Registrar**.
3. **Inicio de Sesión**:
   - Ve a la pestaña **Login**.
   - Introduce tus credenciales registradas y haz clic en **Entrar**.
4. **Crear Documento**:
   - Una vez logueado, rellena el formulario de **Crear documento** con un título y contenido.
   - Presiona **Crear documento** (el documento se guardará en PostgreSQL en estado `PENDIENTE`).
5. **Listado**:
   - Verás el documento listado en la sección inferior con su respectivo ID único.

---

## Pruebas de Integración y Unitarias

Puedes ejecutar las pruebas unitarias de los servicios localmente:

```bash
# Probar Users Service
cd users-service
npm test

# Probar Documents Service
cd ../documents-service
npm test
```

## Documentación

- OpenAPI: `docs/openapi.yaml`
- Arquitectura y despliegue: `docs/arquitectura-y-despliegue.md`
