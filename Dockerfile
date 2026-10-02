# Личный бюджет — образ без внешних зависимостей, сервис на стандартной библиотеке.
FROM python:3.12-alpine

WORKDIR /app
COPY server.py ./
COPY static ./static

# Внутри контейнера слушать 0.0.0.0 обязательно: иначе Docker не сможет
# пробросить порт наружу (см. BUDGET_HOST в server.py). Саму доступность
# снаружи контролирует публикация порта (-p / ports:), а не этот адрес.
ENV BUDGET_HOST=0.0.0.0
ENV BUDGET_DB=/data/budget.db

# Данные — в отдельном томе, переживают пересборку и обновление образа.
VOLUME ["/data"]
EXPOSE 8765

CMD ["python3", "server.py"]
