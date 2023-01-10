"""This is a test program."""
import os
import datetime
import boto3
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from typing import List, Union
from pydantic import BaseModel

AWS_REGION = os.environ.get('AWS_REGION', 'us-west-2')

client = boto3.client('sagemaker', region_name=AWS_REGION)
app = FastAPI()

class Endpoint(BaseModel):
    """This is a test program."""
    EndpointName: str
    EndpointArn: str
    CreationTime: datetime.datetime
    LastModifiedTime: datetime.datetime
    EndpointStatus: str


@app.get('/api/functions')
def function_list():
    """hoge"""
    try:
        #res = client.list_endpoints(StatusEquals='InService')
        #endpoint_names: list[str] = [x['EndpointName'] for x in res['Endpoints']]
        endpoint_names = ['mock-endpoint']
    except Exception as err:
        print(err)
        endpoint_names = []
    result = dict()
    for name in endpoint_names:
        result.update({name: endpoint_to_function(name)})
    return JSONResponse(content=result)

@app.get('/api/functions/{function_name}')
def function_detail(function_name: str):
    """hoge"""
    return JSONResponse(content={})

@app.post('/api/function_invocations')
def function_invoke(x_nuclio_function_name: Union[List[str], None] = Header(default=None)):
    """hoge"""
    return JSONResponse(content={})


def endpoint_to_function(endpoint_name):
    """hoge"""
    #endpoint_config_name = client.describe_endpoint(EndpointName=endpoint_name)['EndpointConfigName']
    #model_name = client.describe_endpoint_config(EndpointConfigName=endpoint_config_name)['ProductionVariants'][0]['ModelName']
    #model = client.describe_model(ModelName=model_name)
    fun = {
        'metadata': {
            'name': endpoint_name,
            'namespace': 'nuclio',
            'labels': {
                'nuclio.io/project-name': 'cvat',
            },
            'annotations': {
                'name': 'endpoint_name#container_name',
                'type': 'detector', # detector interactor reid tracker
                'framework': 'pytorch',
            },
        },
        'spec': {
            'description': 'spec-description',
            'handler': 'main:handler',
            'runtime': 'python'
        },
        'status': {
            'state': 'ready',
            'httpPort': 443,
        },
    }
    return fun
