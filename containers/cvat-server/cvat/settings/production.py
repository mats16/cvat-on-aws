# Copyright (C) 2018-2022 Intel Corporation
#
# SPDX-License-Identifier: MIT

from .base import *

DEBUG = False

NUCLIO['HOST'] = os.getenv('CVAT_NUCLIO_HOST', 'nuclio')
for key in RQ_QUEUES:
    RQ_QUEUES[key]['HOST'] = os.getenv('CVAT_REDIS_HOST', 'cvat_redis')
    RQ_QUEUES[key]['PASSWORD'] = os.getenv('CVAT_REDIS_PASSWORD', '')

# Django-sendfile:
# https://github.com/moggers87/django-sendfile2
SENDFILE_BACKEND = 'django_sendfile.backends.nginx'
SENDFILE_URL = '/'

# Caches
# https://docs.djangoproject.com/en/2.0/ref/settings/#caches
CACHES = {
   'default': {
        'BACKEND': 'django_redis.cache.RedisCache',
        'LOCATION': 'redis://{}:6379/2'.format(os.getenv('CVAT_REDIS_HOST', 'cvat_redis')),
        'OPTIONS': {
            'CLIENT_CLASS': 'django_redis.client.DefaultClient',
        }
    }
}

# CACHE_ROOT = '/tmp/cache'
# SESSION_ENGINE = 'django.contrib.sessions.backends.cached_db'

# Oauth
SOCIAL_APP_LOGIN_REDIRECT_URL = f'{CVAT_BASE_URL}/auth/login-with-social-app'
GITHUB_CALLBACK_URL = f'{CVAT_BASE_URL}/api/auth/github/login/callback/'
GOOGLE_CALLBACK_URL = f'{CVAT_BASE_URL}/api/auth/google/login/callback/'

# Open Policy Agent
IAM_OPA_HOST = os.getenv('IAM_OPA_HOST', 'http://opa.cvat.internal:8181')
IAM_OPA_DATA_URL = f'{IAM_OPA_HOST}/v1/data'
