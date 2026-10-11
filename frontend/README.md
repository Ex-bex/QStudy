# QStudy · интерфейс

Next.js, React и TypeScript. Главная страница с CSS 3D, адаптивное учебное пространство и панель администратора.

Полная инструкция запуска, настройки backend, создания администратора и развёртывания находится в [README проекта](../README.md).

Для обычной локальной работы используйте `Start-QStudy.cmd` в корне проекта: он запускает и frontend, и backend. Команды ниже предназначены для ручного запуска интерфейса. `npm run dev` и `npm run start` по умолчанию слушают только `127.0.0.1`.

```powershell
npm ci
npm run dev -- --port 3000
```

Backend должен работать на `http://127.0.0.1:8000`; другой адрес задаётся серверной переменной `BACKEND_URL`. Браузер обращается к `/api` через Next.js. Не добавляйте ключи ИИ или другие секреты в переменные `NEXT_PUBLIC_*`.

Проверка интерфейса:

```powershell
npm run lint
npm run build
npm audit
```

Для production требуется HTTPS: сессионная cookie имеет флаги `HttpOnly`, `SameSite=Strict` и `Secure`.
