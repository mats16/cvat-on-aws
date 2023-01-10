ARG CVAT_VERSION=dev
FROM --platform=arm64 cvat/server:${CVAT_VERSION}

USER root
RUN pip3 install django-redis==5.2.0

COPY --chown=${USER} ./cvat/settings/production.py /home/django/cvat/settings/production.py

USER ${USER}
