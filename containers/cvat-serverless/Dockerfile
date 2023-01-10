FROM public.ecr.aws/docker/library/python:3.11-alpine

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir --upgrade -r requirements.txt

COPY ./app/ ./

EXPOSE 8070
CMD ["uvicorn", "main:app", "--reload", "--host", "0.0.0.0", "--port", "8070"]
